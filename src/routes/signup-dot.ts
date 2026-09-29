import type { LoaderFunctionArgs } from 'react-router';
import { redirect } from 'react-router';

/** Redirect a common trailing-period typo without broad path normalization. */
export function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  return redirect(`/signup${url.search}`, 308);
}
