export interface ProxyLogEntry {
  t: number;
  iso: string;
  kind: 'HTTP' | 'CONNECT' | 'UPGRADE';
  method?: string;
  target: string;
  mode: 'OPEN' | 'SEALED';
  action?: string;
  up?: number;
  down?: number;
  destroyedAtSeal?: boolean;
  droppedUpAfterSeal?: number;
}

export interface ProxySummary {
  port: number;
  sealedAt: string | null;
  totalAttempts: number;
  preSealAttempts: number;
  postSealAttempts: number;
  postSealAllowed: number;
  postSealRefused: Array<{ iso: string; kind: string; target: string }>;
  tunnelsDestroyedAtSeal: number;
  bytesDroppedUpstreamAfterSeal: number;
  bytesDroppedDownstreamAfterSeal: number;
  refusedByPolicy: Array<{ iso: string; kind: string; target: string }>;
  tunnelledHosts: string[];
  log?: ProxyLogEntry[];
}

export interface GatekeeperProxy {
  port: number;
  state: { sealed: boolean; sealedAt: number | null; log: ProxyLogEntry[] };
  seal(): number;
  summary(): ProxySummary;
  close(): Promise<void>;
}

export function startProxy(opts?: { allowConnect?: (host: string, port: number) => boolean }): Promise<GatekeeperProxy>;
