// js_exec user code runs inside an async function body, so wrap it the same way
// before handing it to sucrase: that makes top-level `return`/`await` parse. The
// wrapper contains no TypeScript, so it survives the transform byte-for-byte and
// can be sliced back off. Executor-style: models may write idiomatic TypeScript
// and the type syntax is stripped before execution. Anything sucrase cannot
// parse falls back to the original code so plain-JS behavior never regresses.
const TS_STRIP_PREFIX = "async function __camelTypeStrip__() {\n";
const TS_STRIP_SUFFIX = "\n}";

export async function stripTypeScriptFromUserCode(userCode: string): Promise<string> {
  if (!userCode.trim()) return userCode;
  try {
    // Sucrase brings its parser/token tables with it. Loading it only when a
    // js_exec module is actually compiled keeps those allocations out of the
    // long-lived ChatThreadDO baseline.
    const { transform } = await import("sucrase");
    const wrapped = `${TS_STRIP_PREFIX}${userCode}${TS_STRIP_SUFFIX}`;
    // Both Workers and Node/Bun support modern JS. Downleveling optional
    // chaining/nullish coalescing can prepend helpers before our wrapper.
    const stripped = transform(wrapped, { transforms: ["typescript"], disableESTransforms: true }).code;
    if (!stripped.startsWith(TS_STRIP_PREFIX) || !stripped.endsWith(TS_STRIP_SUFFIX)) {
      return userCode;
    }
    return stripped.slice(TS_STRIP_PREFIX.length, stripped.length - TS_STRIP_SUFFIX.length);
  } catch {
    return userCode;
  }
}

export function prepareCodeModeUserCode(userCode: string): string {
  if (!userCode.trim() || /\breturn\b/.test(userCode)) return userCode;

  const trailingWhitespace = userCode.match(/\s*$/)?.[0] ?? "";
  const body = userCode.slice(0, userCode.length - trailingWhitespace.length);
  const lines = body.split("\n");
  const lastCodeLineIndex = lines.findLastIndex((line) => {
    const trimmed = line.trim();
    return trimmed !== "" && !trimmed.startsWith("//");
  });
  if (lastCodeLineIndex < 0) return userCode;

  const lastLine = lines[lastCodeLineIndex];
  const expression = lastLine.trim().replace(/;$/, "").trim();
  if (
    !expression ||
    expression.endsWith("}") ||
    /^(?:break|case|catch|class|const|continue|debugger|default|do|else|export|finally|for|function|if|import|let|return|switch|throw|try|var|while|with)\b/.test(expression)
  ) {
    return userCode;
  }

  const indent = lastLine.match(/^\s*/)?.[0] ?? "";
  lines[lastCodeLineIndex] = `${indent}return ${expression};`;
  return `${lines.join("\n")}${trailingWhitespace}`;
}
