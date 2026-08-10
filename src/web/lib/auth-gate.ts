'use client';

// The client side of the gate: any 401 from the API means "no session" —
// leave the page and go to /login. The server never redirects; pages do.

import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { ApiError } from './api';

export function useAuthRedirect(...errors: unknown[]): boolean {
  const router = useRouter();
  const pathname = usePathname();
  const unauthorized = errors.some(error => error instanceof ApiError && error.status === 401);

  useEffect(() => {
    if (unauthorized) {
      // Come back to where the link pointed after the login (secret links
      // land on deep pages).
      router.replace(pathname && pathname !== '/' ? `/login?next=${encodeURIComponent(pathname)}` : '/login');
    }
  }, [unauthorized, router, pathname]);

  return unauthorized;
}

// Only same-site paths survive as a post-login destination.
export function sanitizeNextPath(value: string | null): string {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/';
}
