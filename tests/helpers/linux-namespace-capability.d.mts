export function namespaceUnavailable(probe: {
  error?: Error & { code?: string };
  status?: number | null;
  stderr?: string | null;
}): boolean;
