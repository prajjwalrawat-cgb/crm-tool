// AskMiraa's platform: check the key, find a workspace, create or attach one (src/lib/askmira/platform.ts).
export const dynamic = 'force-dynamic';

import { platformRoute } from '@/lib/askmira/handlers';

export async function POST(req: Request, { params }: { params: Promise<{ action: string }> }) {
  const { action } = await params;
  return platformRoute(req, action);
}
