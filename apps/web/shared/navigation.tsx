import { Link as RouterLink, useNavigate, type LinkProps } from "react-router-dom";
export default function Link({ href, ...props }: Omit<LinkProps, "to"> & { href: string }) {
  return <RouterLink to={href} {...props} />;
}
export function useRouter() {
  const navigate = useNavigate();
  return {
    push: (to: string) => void navigate(to),
    replace: (to: string) => void navigate(to, { replace: true }),
  };
}
