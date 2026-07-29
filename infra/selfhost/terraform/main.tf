data "aws_vpc" "default" {
  count   = var.vpc_id == "" ? 1 : 0
  default = true
}

locals {
  vpc_id = var.vpc_id != "" ? var.vpc_id : data.aws_vpc.default[0].id
}

data "aws_subnets" "selected" {
  count = var.subnet_id == "" ? 1 : 0
  filter {
    name   = "vpc-id"
    values = [local.vpc_id]
  }
}

locals {
  subnet_id         = var.subnet_id != "" ? var.subnet_id : sort(data.aws_subnets.selected[0].ids)[0]
  app_iframe_domain = var.app_iframe_domain != "" ? var.app_iframe_domain : var.app_vanity_domain
  common_tags       = merge({ Name = var.name, Application = "camelAI", Deployment = "selfhost" }, var.tags)
  secret_arns = compact([
    var.selfhost_ai_api_key_secret_arn,
    var.auth_provider == "bundled-pomerium" ? var.pomerium_idp_client_secret_arn : "",
    var.tls_mode == "provided" ? var.tls_certificate_secret_arn : "",
    var.tls_mode == "provided" ? var.tls_private_key_secret_arn : "",
  ])
}

data "aws_subnet" "selected" {
  id = local.subnet_id
}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"]

  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }

  filter {
    name   = "architecture"
    values = ["x86_64"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

check "tls_secrets" {
  assert {
    condition = var.tls_mode != "provided" || (
      var.tls_certificate_secret_arn != "" &&
      var.tls_private_key_secret_arn != ""
    )
    error_message = "tls_certificate_secret_arn and tls_private_key_secret_arn are required when tls_mode=provided."
  }
}

check "route53_zone" {
  assert {
    condition     = (!var.create_route53_records && var.tls_mode != "automatic") || var.route53_zone_id != ""
    error_message = "route53_zone_id is required for automatic TLS or when create_route53_records=true."
  }
}

check "tls_auth_compatibility" {
  assert {
    condition     = var.tls_mode == "external" || var.auth_provider == "bundled-pomerium"
    error_message = "automatic and provided TLS require auth_provider=bundled-pomerium; external identity proxies must terminate TLS upstream."
  }
}

check "auth_configuration" {
  assert {
    condition = (
      var.auth_provider == "cloudflare-access" &&
      var.cloudflare_access_team_domain != "" &&
      var.cloudflare_access_aud != ""
      ) || (
      var.auth_provider == "pomerium" &&
      var.pomerium_authenticate_url != "" &&
      var.pomerium_issuer != "" &&
      var.pomerium_audience != ""
      ) || (
      var.auth_provider == "bundled-pomerium" &&
      var.pomerium_authenticate_url == "https://${var.pomerium_authenticate_hostname}" &&
      var.pomerium_authenticate_hostname != var.main_hostname &&
      var.pomerium_idp_provider != "" &&
      var.pomerium_idp_client_id != "" &&
      var.pomerium_idp_client_secret_arn != "" &&
      (var.pomerium_idp_provider != "oidc" || var.pomerium_idp_provider_url != "")
    )
    error_message = "Configure the selected identity mode. Bundled Pomerium requires a distinct authenticate hostname/URL, IdP settings, and client-secret ARN."
  }
}

check "custom_ai_configuration" {
  assert {
    condition = var.selfhost_ai_provider != "custom" || (
      var.selfhost_ai_base_url != "" &&
      var.selfhost_ai_model != ""
    )
    error_message = "selfhost_ai_base_url and selfhost_ai_model are required for the custom AI provider."
  }
}

resource "aws_security_group" "selfhost" {
  name_prefix = "${var.name}-"
  description = "camelAI single-node self-host ingress"
  vpc_id      = local.vpc_id

  dynamic "ingress" {
    for_each = var.web_ingress_cidrs
    content {
      description = contains(["automatic", "provided"], var.tls_mode) ? "HTTP redirect and ACME fallback" : "HTTP origin for external TLS proxy"
      protocol    = "tcp"
      from_port   = 80
      to_port     = 80
      cidr_blocks = [ingress.value]
    }
  }

  dynamic "ingress" {
    for_each = contains(["automatic", "provided"], var.tls_mode) ? var.web_ingress_cidrs : []
    content {
      description = "HTTPS"
      protocol    = "tcp"
      from_port   = 443
      to_port     = 443
      cidr_blocks = [ingress.value]
    }
  }

  dynamic "ingress" {
    for_each = var.ssh_ingress_cidrs
    content {
      description = "Optional break-glass SSH"
      protocol    = "tcp"
      from_port   = 22
      to_port     = 22
      cidr_blocks = [ingress.value]
    }
  }

  egress {
    protocol    = "-1"
    from_port   = 0
    to_port     = 0
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = local.common_tags
}

resource "aws_iam_role" "selfhost" {
  name_prefix = "${var.name}-"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Action    = "sts:AssumeRole"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })
  tags = local.common_tags
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.selfhost.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_role_policy" "secrets" {
  name = "ReadCamelAISelfhostSecrets"
  role = aws_iam_role.selfhost.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = ["secretsmanager:GetSecretValue"]
      Resource = local.secret_arns
    }]
  })
}

resource "aws_iam_role_policy" "tls_dns01" {
  count = var.tls_mode == "automatic" ? 1 : 0
  name  = "ManageCamelAITlsDnsChallenge"
  role  = aws_iam_role.selfhost.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["route53:ListHostedZones", "route53:ListHostedZonesByName"]
        Resource = "*"
      },
      {
        Effect   = "Allow"
        Action   = ["route53:ListResourceRecordSets"]
        Resource = "arn:aws:route53:::hostedzone/${var.route53_zone_id}"
      },
      {
        Effect   = "Allow"
        Action   = ["route53:GetChange"]
        Resource = "arn:aws:route53:::change/*"
      },
      {
        Effect   = "Allow"
        Action   = ["route53:ChangeResourceRecordSets"]
        Resource = "arn:aws:route53:::hostedzone/${var.route53_zone_id}"
        Condition = {
          "ForAllValues:StringEquals" = {
            "route53:ChangeResourceRecordSetsRecordTypes" = "TXT"
          }
          "ForAllValues:StringLike" = {
            "route53:ChangeResourceRecordSetsNormalizedRecordNames" = "_acme-challenge.*"
          }
        }
      },
    ]
  })
}

resource "aws_iam_instance_profile" "selfhost" {
  name_prefix = "${var.name}-"
  role        = aws_iam_role.selfhost.name
  tags        = local.common_tags
}

resource "aws_ebs_volume" "data" {
  availability_zone = data.aws_subnet.selected.availability_zone
  encrypted         = true
  kms_key_id        = var.ebs_kms_key_id != "" ? var.ebs_kms_key_id : null
  size              = var.data_volume_size_gb
  type              = "gp3"
  tags              = merge(local.common_tags, { Name = "${var.name}-data" })
}

locals {
  cloud_init = templatefile("${path.module}/cloud-init.sh.tpl", {
    aws_region_b64                     = base64encode(var.aws_region)
    data_volume_id_b64                 = base64encode(aws_ebs_volume.data.id)
    repository_url_b64                 = base64encode(var.repository_url)
    repository_ref_b64                 = base64encode(var.repository_ref)
    app_image_b64                      = base64encode(var.app_image)
    local_artifacts_image_b64          = base64encode(var.local_artifacts_image)
    project_build_image_b64            = base64encode(var.project_build_image)
    analysis_image_b64                 = base64encode(var.analysis_image)
    db_query_image_b64                 = base64encode(var.db_query_image)
    container_egress_image_b64         = base64encode(var.container_egress_image)
    caddy_image_b64                    = base64encode(var.caddy_image)
    main_hostname_b64                  = base64encode(lower(var.main_hostname))
    app_vanity_domain_b64              = base64encode(lower(var.app_vanity_domain))
    app_iframe_domain_b64              = base64encode(lower(local.app_iframe_domain))
    tls_mode_b64                       = base64encode(var.tls_mode)
    tls_certificate_secret_arn_b64     = base64encode(var.tls_certificate_secret_arn)
    tls_private_key_secret_arn_b64     = base64encode(var.tls_private_key_secret_arn)
    route53_zone_id_b64                = base64encode(var.route53_zone_id)
    auth_provider_b64                  = base64encode(var.auth_provider)
    auth_default_org_name_b64          = base64encode(var.auth_default_org_name)
    cloudflare_access_team_domain_b64  = base64encode(var.cloudflare_access_team_domain)
    cloudflare_access_aud_b64          = base64encode(var.cloudflare_access_aud)
    pomerium_authenticate_url_b64      = base64encode(var.pomerium_authenticate_url)
    pomerium_authenticate_hostname_b64 = base64encode(var.pomerium_authenticate_hostname)
    pomerium_image_b64                 = base64encode(var.pomerium_image)
    pomerium_jwks_url_b64              = base64encode(var.pomerium_jwks_url)
    pomerium_idp_provider_b64          = base64encode(var.pomerium_idp_provider)
    pomerium_idp_provider_url_b64      = base64encode(var.pomerium_idp_provider_url)
    pomerium_idp_client_id_b64         = base64encode(var.pomerium_idp_client_id)
    pomerium_idp_client_secret_arn_b64 = base64encode(var.pomerium_idp_client_secret_arn)
    pomerium_issuer_b64                = base64encode(var.pomerium_issuer)
    pomerium_audience_b64              = base64encode(var.pomerium_audience)
    selfhost_ai_provider_b64           = base64encode(var.selfhost_ai_provider)
    selfhost_ai_api_key_secret_arn_b64 = base64encode(var.selfhost_ai_api_key_secret_arn)
    selfhost_ai_aws_region_b64         = base64encode(var.selfhost_ai_aws_region)
    selfhost_ai_base_url_b64           = base64encode(var.selfhost_ai_base_url)
    selfhost_ai_model_b64              = base64encode(var.selfhost_ai_model)
    selfhost_ai_name_b64               = base64encode(var.selfhost_ai_name)
    selfhost_ai_api_b64                = base64encode(var.selfhost_ai_api)
    selfhost_ai_auth_type_b64          = base64encode(var.selfhost_ai_auth_type)
  })
}

resource "aws_instance" "selfhost" {
  ami                         = data.aws_ami.ubuntu.id
  instance_type               = var.instance_type
  subnet_id                   = local.subnet_id
  vpc_security_group_ids      = [aws_security_group.selfhost.id]
  associate_public_ip_address = true
  key_name                    = var.ssh_key_name != "" ? var.ssh_key_name : null
  iam_instance_profile        = aws_iam_instance_profile.selfhost.name
  # The bootstrap intentionally includes all deployment validation. Compress it
  # so the decoded cloud-init payload stays within EC2's 16 KiB user-data limit.
  user_data_base64            = base64gzip(local.cloud_init)
  user_data_replace_on_change = true

  metadata_options {
    http_endpoint               = "enabled"
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }

  root_block_device {
    encrypted             = true
    kms_key_id            = var.ebs_kms_key_id != "" ? var.ebs_kms_key_id : null
    volume_size           = var.root_volume_size_gb
    volume_type           = "gp3"
    delete_on_termination = true
  }

  tags = local.common_tags

  depends_on = [
    aws_iam_role_policy_attachment.ssm,
    aws_iam_role_policy.secrets,
    aws_iam_role_policy.tls_dns01,
  ]
}

resource "aws_volume_attachment" "data" {
  device_name = "/dev/sdf"
  volume_id   = aws_ebs_volume.data.id
  instance_id = aws_instance.selfhost.id
}

resource "aws_ssm_association" "bootstrap_ready" {
  name = "AWS-RunShellScript"

  targets {
    key    = "InstanceIds"
    values = [aws_instance.selfhost.id]
  }

  parameters = {
    commands = <<-COMMAND
      deadline=$((SECONDS + 1800))
      until test -f /var/lib/camelai-selfhost/ready; do
        if test -f /var/lib/camelai-selfhost/failed; then
          echo "camelAI bootstrap or attached-runtime smoke failed" >&2
          exit 1
        fi
        if test "$SECONDS" -ge "$deadline"; then
          echo "Timed out waiting for camelAI bootstrap readiness" >&2
          exit 1
        fi
        sleep 5
      done
    COMMAND
  }

  wait_for_success_timeout_seconds = 2100

  depends_on = [aws_volume_attachment.data]
}

resource "aws_eip" "selfhost" {
  domain   = "vpc"
  instance = aws_instance.selfhost.id
  tags     = local.common_tags
}

resource "aws_route53_record" "main" {
  count   = var.create_route53_records ? 1 : 0
  zone_id = var.route53_zone_id
  name    = var.main_hostname
  type    = "A"
  ttl     = 60
  records = [aws_eip.selfhost.public_ip]
}

resource "aws_route53_record" "apps" {
  count   = var.create_route53_records ? 1 : 0
  zone_id = var.route53_zone_id
  name    = "*.${var.app_vanity_domain}"
  type    = "A"
  ttl     = 60
  records = [aws_eip.selfhost.public_ip]
}

resource "aws_route53_record" "pomerium_authenticate" {
  count   = var.create_route53_records && var.auth_provider == "bundled-pomerium" ? 1 : 0
  zone_id = var.route53_zone_id
  name    = var.pomerium_authenticate_hostname
  type    = "A"
  ttl     = 60
  records = [aws_eip.selfhost.public_ip]
}
