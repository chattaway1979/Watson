import { connectorStatus } from '@/lib/it-agent/mock-microsoft365';
import { deviceConnectorStatus } from '@/lib/it-agent/mock-device-management';
import { operatingMode, isLiveExternalExecutionEnabled } from '@/lib/it-agent/constants';
import { ok } from '@/lib/http';

export async function GET() {
  return ok({
    mode: operatingMode(),
    liveExecutionEnabled: isLiveExternalExecutionEnabled(),
    connectors: [connectorStatus(), deviceConnectorStatus()]
  });
}
