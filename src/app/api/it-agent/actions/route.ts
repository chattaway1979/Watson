import { listActions } from '@/lib/it-agent/action-registry';
import { ok } from '@/lib/http';
export async function GET() {
  return ok(listActions());
}
