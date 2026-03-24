export type ArtifactInput = {
  clarificationId?: string | null;
  eventId?: string | null;
  marketText?: string | null;
  suggestedEditedMarketText?: string | null;
  clarificationNote?: string | null;
  generatedAtUtc?: string | null;
  [key: string]: unknown;
};

export type ArtifactRecord = ArtifactInput & {
  cid: string;
  url: string;
};

export type BackgroundJob = {
  jobId: string;
  status: string;
  [key: string]: unknown;
};

export type CategoryCatalog = {
  categories: string[];
  updatedAt: string | null;
};

export type ClarificationStatusHistoryEntry = {
  status: string;
  timestamp: string;
};

export type ReviewerAction = {
  type: string;
  timestamp: string;
  actor?: string | null;
  [key: string]: unknown;
};

export type ClarificationRequest = {
  requestId: string;
  eventId: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  clarificationId?: string | null;
  question?: string | null;
  requesterId?: string | null;
  telegramChatId?: string | null;
  telegramUserId?: string | null;
  summary?: string | null;
  errorMessage?: string | null;
  retryable?: boolean;
  llmOutput?: unknown;
  llmTrace?: unknown;
  artifactCid?: string | null;
  artifactUrl?: string | null;
  reviewerWorkflowStatus?: string | null;
  finalEditedText?: string | null;
  finalNote?: string | null;
  finalizedAt?: string | null;
  finalizedBy?: string | null;
  reviewerActions?: ReviewerAction[];
  statusHistory?: ClarificationStatusHistoryEntry[];
  paymentProof?: string | null;
  paymentReference?: string | null;
  timing?: unknown;
  [key: string]: unknown;
};

export type ContractRecord = {
  instrumentSymbol?: string | null;
  [key: string]: unknown;
};

export type MarketRecord = {
  marketId: string;
  status?: string | null;
  createdAt?: string | null;
  title?: string | null;
  resolution?: string | null;
  resolutionText?: string | null;
  closesAt?: string | null;
  endTime?: string | null;
  url?: string | null;
  category?: string | null;
  termsLink?: string | null;
  contracts?: ContractRecord[];
  [key: string]: unknown;
};

export type ReviewerScan = {
  eventId: string;
  createdAt: string;
  jobId?: string | null;
  marketTextKey?: string | null;
  [key: string]: unknown;
};

export type SyncStateMap = Record<string, unknown>;

export type TradeActivity = {
  eventId: string;
  instruments?: Record<string, unknown>;
  recentTrades?: unknown[];
  [key: string]: unknown;
};

export type VerifiedPayment = {
  paymentProof?: string | null;
  paymentReference?: string | null;
  clarificationId?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  paymentVerifiedAt?: string | null;
  [key: string]: unknown;
};
