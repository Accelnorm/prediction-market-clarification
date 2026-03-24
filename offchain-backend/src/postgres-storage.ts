import { Pool } from "pg";

import { createArtifactCid } from "./artifact-repository.js";

function normalizeClient(clientOrPool) {
  return clientOrPool ?? null;
}

async function query(clientOrPool, sql, params: any[] = []) {
  return clientOrPool.query(sql, params);
}

function parsePayloadRow(row) {
  return row?.payload ?? null;
}

function uniqueMarkets(markets: any[] = []) {
  const dedupedById = new Map();

  for (const market of Array.isArray(markets) ? markets : []) {
    if (!market || typeof market.marketId !== "string" || market.marketId === "") {
      continue;
    }

    dedupedById.set(market.marketId, market);
  }

  return [...dedupedById.values()].sort((left, right) => left.marketId.localeCompare(right.marketId));
}

function parseBooleanEnv(value) {
  return value === "1" || value === "true";
}

export function createPostgresPool(connectionString) {
  return new Pool({
    connectionString
  });
}

export async function initializePostgresSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clarifications (
      clarification_id TEXT PRIMARY KEY,
      request_id TEXT NULL,
      event_id TEXT NULL,
      payment_proof TEXT NULL UNIQUE,
      created_at TIMESTAMPTZ NULL,
      updated_at TIMESTAMPTZ NULL,
      status TEXT NULL,
      source TEXT NULL,
      payload JSONB NOT NULL
    );

    CREATE INDEX IF NOT EXISTS clarifications_event_id_idx
      ON clarifications (event_id);

    CREATE INDEX IF NOT EXISTS clarifications_created_at_idx
      ON clarifications (created_at DESC);

    CREATE TABLE IF NOT EXISTS verified_payments (
      payment_proof TEXT PRIMARY KEY,
      payment_reference TEXT NULL,
      clarification_id TEXT NULL,
      created_at TIMESTAMPTZ NULL,
      updated_at TIMESTAMPTZ NULL,
      payload JSONB NOT NULL
    );

    CREATE INDEX IF NOT EXISTS verified_payments_reference_idx
      ON verified_payments (payment_reference);

    CREATE TABLE IF NOT EXISTS background_jobs (
      job_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      retryable BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NULL,
      updated_at TIMESTAMPTZ NULL,
      target_clarification_id TEXT NULL,
      target_event_id TEXT NULL,
      payload JSONB NOT NULL
    );

    CREATE INDEX IF NOT EXISTS background_jobs_status_kind_idx
      ON background_jobs (status, kind);

    CREATE TABLE IF NOT EXISTS artifacts (
      cid TEXT PRIMARY KEY,
      clarification_id TEXT NULL,
      event_id TEXT NULL,
      generated_at_utc TIMESTAMPTZ NULL,
      payload JSONB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS market_cache (
      market_stage TEXT NOT NULL,
      market_id TEXT NOT NULL,
      status TEXT NULL,
      closes_at TIMESTAMPTZ NULL,
      payload JSONB NOT NULL,
      PRIMARY KEY (market_stage, market_id)
    );

    CREATE INDEX IF NOT EXISTS market_cache_stage_status_idx
      ON market_cache (market_stage, status);

    CREATE TABLE IF NOT EXISTS reviewer_scans (
      market_stage TEXT NOT NULL,
      scan_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      job_id TEXT NULL,
      created_at TIMESTAMPTZ NULL,
      payload JSONB NOT NULL,
      PRIMARY KEY (market_stage, scan_id)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS reviewer_scans_stage_job_id_idx
      ON reviewer_scans (market_stage, job_id)
      WHERE job_id IS NOT NULL;

    CREATE INDEX IF NOT EXISTS reviewer_scans_stage_event_id_idx
      ON reviewer_scans (market_stage, event_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS market_sync_state (
      scope TEXT PRIMARY KEY,
      updated_at TIMESTAMPTZ NULL,
      payload JSONB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS category_catalogs (
      scope TEXT PRIMARY KEY,
      updated_at TIMESTAMPTZ NULL,
      payload JSONB NOT NULL
    );

    CREATE TABLE IF NOT EXISTS trade_activity (
      event_id TEXT PRIMARY KEY,
      last_trade_at TIMESTAMPTZ NULL,
      last_fetched_at TIMESTAMPTZ NULL,
      payload JSONB NOT NULL
    );

    CREATE INDEX IF NOT EXISTS trade_activity_last_trade_at_idx
      ON trade_activity (last_trade_at DESC NULLS LAST);
  `);
}

export async function checkPostgresReadiness(pool) {
  await pool.query("SELECT 1");
  return {
    ok: true,
    checks: {
      database: "ok"
    }
  };
}

export class PostgresClarificationRequestRepository {
  private pool: Pool;
  constructor(pool) {
    this.pool = pool;
  }

  async create(request, client: any = null) {
    const db = normalizeClient(client) ?? this.pool;
    const payload = {
      ...request,
      updatedAt: request.updatedAt ?? request.createdAt,
      clarificationId: request.clarificationId ?? null,
      summary: request.summary ?? null,
      errorMessage: request.errorMessage ?? null,
      retryable: request.retryable ?? false,
      llmOutput: request.llmOutput ?? null,
      llmTrace: request.llmTrace ?? null,
      artifactCid: request.artifactCid ?? null,
      artifactUrl: request.artifactUrl ?? null,
      reviewerWorkflowStatus: request.reviewerWorkflowStatus ?? null,
      finalEditedText: request.finalEditedText ?? null,
      finalNote: request.finalNote ?? null,
      finalizedAt: request.finalizedAt ?? null,
      finalizedBy: request.finalizedBy ?? null,
      reviewerActions: Array.isArray(request.reviewerActions) ? request.reviewerActions : [],
      statusHistory: Array.isArray(request.statusHistory)
        ? request.statusHistory
        : [{ status: request.status, timestamp: request.updatedAt ?? request.createdAt }]
    };

    await query(
      db,
      `
        INSERT INTO clarifications (
          clarification_id,
          request_id,
          event_id,
          payment_proof,
          created_at,
          updated_at,
          status,
          source,
          payload
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
      `,
      [
        payload.clarificationId,
        payload.requestId,
        payload.eventId,
        payload.paymentProof ?? null,
        payload.createdAt ?? null,
        payload.updatedAt ?? payload.createdAt ?? null,
        payload.status ?? null,
        payload.source ?? null,
        JSON.stringify(payload)
      ]
    );

    return payload;
  }

  async findByTelegramIdentifiers({ telegramChatId, telegramUserId }) {
    const conditions: string[] = [];
    const params: any[] = [];

    if (telegramChatId) {
      params.push(telegramChatId);
      conditions.push(`payload->>'telegramChatId' = $${params.length}`);
    }

    if (telegramUserId) {
      params.push(telegramUserId);
      conditions.push(`payload->>'telegramUserId' = $${params.length}`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.pool.query(
      `SELECT payload FROM clarifications ${whereClause} ORDER BY created_at DESC NULLS LAST`,
      params
    );

    return result.rows.map(parsePayloadRow);
  }

  async findByRequestId(requestId) {
    const result = await this.pool.query(
      `SELECT payload FROM clarifications WHERE request_id = $1 LIMIT 1`,
      [requestId]
    );
    return parsePayloadRow(result.rows[0]);
  }

  async findByClarificationId(clarificationId) {
    const result = await this.pool.query(
      `SELECT payload FROM clarifications WHERE clarification_id = $1 LIMIT 1`,
      [clarificationId]
    );
    return parsePayloadRow(result.rows[0]);
  }

  async findByPaymentProof(paymentProof) {
    const result = await this.pool.query(
      `SELECT payload FROM clarifications WHERE payment_proof = $1 LIMIT 1`,
      [paymentProof]
    );
    return parsePayloadRow(result.rows[0]);
  }

  async list() {
    const result = await this.pool.query(
      `SELECT payload FROM clarifications ORDER BY created_at DESC NULLS LAST`
    );
    return result.rows.map(parsePayloadRow);
  }

  async findByEventId(eventId) {
    const result = await this.pool.query(
      `SELECT payload FROM clarifications WHERE event_id = $1 ORDER BY created_at DESC NULLS LAST`,
      [eventId]
    );
    return result.rows.map(parsePayloadRow);
  }

  async updateStatus(requestId, updates) {
    const existingRequest = await this.findByRequestId(requestId);

    if (!existingRequest) {
      return null;
    }

    const nextRequest = {
      ...existingRequest,
      status: updates.status,
      updatedAt: updates.updatedAt,
      clarificationId: updates.clarificationId ?? existingRequest.clarificationId ?? null,
      summary: updates.summary ?? existingRequest.summary ?? null,
      errorMessage: updates.errorMessage ?? existingRequest.errorMessage ?? null,
      statusHistory: [
        ...(Array.isArray(existingRequest.statusHistory) ? existingRequest.statusHistory : []),
        {
          status: updates.status,
          timestamp: updates.updatedAt
        }
      ]
    };

    await this.pool.query(
      `
        UPDATE clarifications
        SET status = $2,
            updated_at = $3,
            payload = $4::jsonb
        WHERE clarification_id = $1
      `,
      [
        existingRequest.clarificationId,
        nextRequest.status ?? null,
        nextRequest.updatedAt ?? null,
        JSON.stringify(nextRequest)
      ]
    );

    return nextRequest;
  }

  async updateByClarificationId(clarificationId, updates) {
    const existingRequest = await this.findByClarificationId(clarificationId);

    if (!existingRequest) {
      return null;
    }

    const nextStatus = updates.status ?? existingRequest.status;
    const nextUpdatedAt = updates.updatedAt ?? existingRequest.updatedAt;
    const shouldAppendStatusHistory =
      typeof updates.status === "string" && updates.status !== existingRequest.status;
    const nextRequest = {
      ...existingRequest,
      ...updates,
      status: nextStatus,
      updatedAt: nextUpdatedAt,
      errorMessage:
        Object.prototype.hasOwnProperty.call(updates, "errorMessage")
          ? updates.errorMessage
          : existingRequest.errorMessage ?? null,
      retryable:
        Object.prototype.hasOwnProperty.call(updates, "retryable")
          ? updates.retryable
          : existingRequest.retryable ?? false,
      llmOutput:
        Object.prototype.hasOwnProperty.call(updates, "llmOutput")
          ? updates.llmOutput
          : existingRequest.llmOutput ?? null,
      llmTrace:
        Object.prototype.hasOwnProperty.call(updates, "llmTrace")
          ? updates.llmTrace
          : existingRequest.llmTrace ?? null,
      artifactCid:
        Object.prototype.hasOwnProperty.call(updates, "artifactCid")
          ? updates.artifactCid
          : existingRequest.artifactCid ?? null,
      artifactUrl:
        Object.prototype.hasOwnProperty.call(updates, "artifactUrl")
          ? updates.artifactUrl
          : existingRequest.artifactUrl ?? null,
      reviewerWorkflowStatus:
        Object.prototype.hasOwnProperty.call(updates, "reviewerWorkflowStatus")
          ? updates.reviewerWorkflowStatus
          : existingRequest.reviewerWorkflowStatus ?? null,
      finalEditedText:
        Object.prototype.hasOwnProperty.call(updates, "finalEditedText")
          ? updates.finalEditedText
          : existingRequest.finalEditedText ?? null,
      finalNote:
        Object.prototype.hasOwnProperty.call(updates, "finalNote")
          ? updates.finalNote
          : existingRequest.finalNote ?? null,
      finalizedAt:
        Object.prototype.hasOwnProperty.call(updates, "finalizedAt")
          ? updates.finalizedAt
          : existingRequest.finalizedAt ?? null,
      finalizedBy:
        Object.prototype.hasOwnProperty.call(updates, "finalizedBy")
          ? updates.finalizedBy
          : existingRequest.finalizedBy ?? null,
      reviewerActions:
        Object.prototype.hasOwnProperty.call(updates, "reviewerActions")
          ? updates.reviewerActions
          : existingRequest.reviewerActions ?? [],
      statusHistory: shouldAppendStatusHistory
        ? [
            ...(Array.isArray(existingRequest.statusHistory) ? existingRequest.statusHistory : []),
            {
              status: updates.status,
              timestamp: nextUpdatedAt
            }
          ]
        : existingRequest.statusHistory
    };

    await this.pool.query(
      `
        UPDATE clarifications
        SET status = $2,
            updated_at = $3,
            payload = $4::jsonb
        WHERE clarification_id = $1
      `,
      [
        clarificationId,
        nextRequest.status ?? null,
        nextRequest.updatedAt ?? null,
        JSON.stringify(nextRequest)
      ]
    );

    return nextRequest;
  }
}

export class PostgresVerifiedPaymentRepository {
  private pool: Pool;
  constructor(pool) {
    this.pool = pool;
  }

  async create(payment, client: any = null) {
    const db = normalizeClient(client) ?? this.pool;
    const payload = {
      ...payment,
      clarificationId: payment.clarificationId ?? null,
      createdAt: payment.createdAt ?? payment.paymentVerifiedAt ?? null,
      updatedAt: payment.updatedAt ?? payment.paymentVerifiedAt ?? null
    };

    await query(
      db,
      `
        INSERT INTO verified_payments (
          payment_proof,
          payment_reference,
          clarification_id,
          created_at,
          updated_at,
          payload
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb)
        ON CONFLICT (payment_proof) DO NOTHING
      `,
      [
        payload.paymentProof,
        payload.paymentReference ?? null,
        payload.clarificationId ?? null,
        payload.createdAt ?? null,
        payload.updatedAt ?? null,
        JSON.stringify(payload)
      ]
    );

    return payload;
  }

  async findByPaymentProof(paymentProof) {
    const result = await this.pool.query(
      `SELECT payload FROM verified_payments WHERE payment_proof = $1 LIMIT 1`,
      [paymentProof]
    );
    return parsePayloadRow(result.rows[0]);
  }

  async findByPaymentReference(paymentReference) {
    const result = await this.pool.query(
      `SELECT payload FROM verified_payments WHERE payment_reference = $1 LIMIT 1`,
      [paymentReference]
    );
    return parsePayloadRow(result.rows[0]);
  }

  async updateByPaymentProof(paymentProof, updates, client: any = null) {
    const db = normalizeClient(client) ?? this.pool;
    const existingPaymentResult = await query(
      db,
      `SELECT payload FROM verified_payments WHERE payment_proof = $1 LIMIT 1`,
      [paymentProof]
    );
    const existingPayment = parsePayloadRow(existingPaymentResult.rows[0]);

    if (!existingPayment) {
      return null;
    }

    const nextPayment = {
      ...existingPayment,
      ...updates,
      updatedAt: updates.updatedAt ?? existingPayment.updatedAt
    };

    await query(
      db,
      `
        UPDATE verified_payments
        SET payment_reference = $2,
            clarification_id = $3,
            updated_at = $4,
            payload = $5::jsonb
        WHERE payment_proof = $1
      `,
      [
        paymentProof,
        nextPayment.paymentReference ?? null,
        nextPayment.clarificationId ?? null,
        nextPayment.updatedAt ?? null,
        JSON.stringify(nextPayment)
      ]
    );

    return nextPayment;
  }

  async list() {
    const result = await this.pool.query(
      `SELECT payload FROM verified_payments ORDER BY created_at DESC NULLS LAST`
    );
    return result.rows.map(parsePayloadRow);
  }
}

export class PostgresBackgroundJobRepository {
  private pool: Pool;
  constructor(pool) {
    this.pool = pool;
  }

  async saveJob(job, client: any = null) {
    const db = normalizeClient(client) ?? this.pool;
    await query(
      db,
      `
        INSERT INTO background_jobs (
          job_id,
          kind,
          status,
          attempts,
          retryable,
          created_at,
          updated_at,
          target_clarification_id,
          target_event_id,
          payload
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
        ON CONFLICT (job_id) DO UPDATE
        SET kind = EXCLUDED.kind,
            status = EXCLUDED.status,
            attempts = EXCLUDED.attempts,
            retryable = EXCLUDED.retryable,
            created_at = EXCLUDED.created_at,
            updated_at = EXCLUDED.updated_at,
            target_clarification_id = EXCLUDED.target_clarification_id,
            target_event_id = EXCLUDED.target_event_id,
            payload = EXCLUDED.payload
      `,
      [
        job.jobId,
        job.kind,
        job.status,
        job.attempts ?? 0,
        job.retryable ?? false,
        job.createdAt ?? null,
        job.updatedAt ?? null,
        job.target?.clarificationId ?? null,
        job.target?.eventId ?? null,
        JSON.stringify(job)
      ]
    );
  }

  async create(job, client: any = null) {
    await this.saveJob(job, client);
    return job;
  }

  async list() {
    const result = await this.pool.query(
      `SELECT payload FROM background_jobs ORDER BY created_at DESC NULLS LAST`
    );
    return result.rows.map(parsePayloadRow);
  }

  async findByJobId(jobId) {
    const result = await this.pool.query(
      `SELECT payload FROM background_jobs WHERE job_id = $1 LIMIT 1`,
      [jobId]
    );
    return parsePayloadRow(result.rows[0]);
  }

  async updateByJobId(jobId, updates) {
    const existingJob = await this.findByJobId(jobId);

    if (!existingJob) {
      return null;
    }

    const nextJob = {
      ...existingJob,
      ...updates
    };
    await this.saveJob(nextJob);
    return nextJob;
  }

  async listRecoverable() {
    const result = await this.pool.query(
      `
        SELECT payload
        FROM background_jobs
        WHERE status IN ('queued', 'processing')
        ORDER BY created_at ASC NULLS LAST
      `
    );
    return result.rows.map(parsePayloadRow);
  }
}

export class PostgresArtifactRepository {
  private pool: Pool;
  constructor(pool) {
    this.pool = pool;
  }

  async createArtifact(input) {
    const cid = input.cid ?? createArtifactCid(input);
    const existingArtifact = cid ? await this.findByCid(cid) : null;

    if (existingArtifact) {
      return existingArtifact;
    }

    const artifact = {
      ...input,
      cid,
      url: input.url ?? `ipfs://${cid}`
    };

    await this.pool.query(
      `
        INSERT INTO artifacts (
          cid,
          clarification_id,
          event_id,
          generated_at_utc,
          payload
        )
        VALUES ($1, $2, $3, $4, $5::jsonb)
        ON CONFLICT (cid) DO NOTHING
      `,
      [
        artifact.cid,
        artifact.clarificationId ?? null,
        artifact.eventId ?? null,
        artifact.generatedAtUtc ?? null,
        JSON.stringify(artifact)
      ]
    );

    return (await this.findByCid(artifact.cid)) ?? artifact;
  }

  async findByCid(cid) {
    const result = await this.pool.query(
      `SELECT payload FROM artifacts WHERE cid = $1 LIMIT 1`,
      [cid]
    );
    return parsePayloadRow(result.rows[0]);
  }
}

export class PostgresMarketCacheRepository {
  private pool: Pool;
  private marketStage: string;
  constructor(pool, marketStage = "active") {
    this.pool = pool;
    this.marketStage = marketStage;
  }

  async load() {
    return {
      markets: await this.list()
    };
  }

  async save(markets) {
    const unique = uniqueMarkets(markets);
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM market_cache WHERE market_stage = $1`, [this.marketStage]);

      for (const market of unique) {
        await client.query(
          `
            INSERT INTO market_cache (
              market_stage,
              market_id,
              status,
              closes_at,
              payload
            )
            VALUES ($1, $2, $3, $4, $5::jsonb)
          `,
          [
            this.marketStage,
            market.marketId,
            market.status ?? null,
            market.closesAt ?? market.endTime ?? null,
            JSON.stringify(market)
          ]
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async list() {
    const result = await this.pool.query(
      `
        SELECT payload
        FROM market_cache
        WHERE market_stage = $1
        ORDER BY market_id ASC
      `,
      [this.marketStage]
    );
    return uniqueMarkets(result.rows.map(parsePayloadRow));
  }

  async findByMarketId(marketId) {
    const result = await this.pool.query(
      `
        SELECT payload
        FROM market_cache
        WHERE market_stage = $1 AND market_id = $2
        LIMIT 1
      `,
      [this.marketStage, marketId]
    );
    return parsePayloadRow(result.rows[0]);
  }

  async upsert(market) {
    await this.pool.query(
      `
        INSERT INTO market_cache (
          market_stage,
          market_id,
          status,
          closes_at,
          payload
        )
        VALUES ($1, $2, $3, $4, $5::jsonb)
        ON CONFLICT (market_stage, market_id) DO UPDATE
        SET status = EXCLUDED.status,
            closes_at = EXCLUDED.closes_at,
            payload = EXCLUDED.payload
      `,
      [
        this.marketStage,
        market.marketId,
        market.status ?? null,
        market.closesAt ?? market.endTime ?? null,
        JSON.stringify(market)
      ]
    );
    return market;
  }
}

export class PostgresReviewerScanRepository {
  private pool: Pool;
  private marketStage: string;
  constructor(pool, marketStage = "active") {
    this.pool = pool;
    this.marketStage = marketStage;
  }

  async list() {
    const result = await this.pool.query(
      `
        SELECT payload
        FROM reviewer_scans
        WHERE market_stage = $1
        ORDER BY created_at DESC NULLS LAST
      `,
      [this.marketStage]
    );
    return result.rows.map(parsePayloadRow);
  }

  async findLatestByEventId(eventId) {
    const result = await this.pool.query(
      `
        SELECT payload
        FROM reviewer_scans
        WHERE market_stage = $1 AND event_id = $2
        ORDER BY created_at DESC NULLS LAST
        LIMIT 1
      `,
      [this.marketStage, eventId]
    );
    return parsePayloadRow(result.rows[0]);
  }

  async create(scan) {
    await this.pool.query(
      `
        INSERT INTO reviewer_scans (
          market_stage,
          scan_id,
          event_id,
          job_id,
          created_at,
          payload
        )
        VALUES ($1, $2, $3, $4, $5, $6::jsonb)
        ON CONFLICT (market_stage, scan_id) DO UPDATE
        SET event_id = EXCLUDED.event_id,
            job_id = EXCLUDED.job_id,
            created_at = EXCLUDED.created_at,
            payload = EXCLUDED.payload
      `,
      [
        this.marketStage,
        scan.scanId,
        scan.eventId,
        scan.jobId ?? null,
        scan.createdAt ?? null,
        JSON.stringify(scan)
      ]
    );
    return scan;
  }
}

export class PostgresSyncStateRepository {
  private pool: Pool;
  constructor(pool) {
    this.pool = pool;
  }

  async getState(scope) {
    const result = await this.pool.query(
      `SELECT payload FROM market_sync_state WHERE scope = $1 LIMIT 1`,
      [scope]
    );
    return parsePayloadRow(result.rows[0]);
  }

  async setState(scope, value) {
    await this.pool.query(
      `
        INSERT INTO market_sync_state (scope, updated_at, payload)
        VALUES ($1, $2, $3::jsonb)
        ON CONFLICT (scope) DO UPDATE
        SET updated_at = EXCLUDED.updated_at,
            payload = EXCLUDED.payload
      `,
      [scope, value?.updatedAt ?? null, JSON.stringify(value)]
    );
    return value;
  }
}

export class PostgresCategoryCatalogRepository {
  private pool: Pool;
  constructor(pool) {
    this.pool = pool;
  }

  async getCatalog(scope) {
    const result = await this.pool.query(
      `SELECT payload FROM category_catalogs WHERE scope = $1 LIMIT 1`,
      [scope]
    );
    return parsePayloadRow(result.rows[0]) ?? { categories: [], updatedAt: null };
  }

  async setCatalog(scope, value) {
    const payload = {
      categories: [...new Set((value?.categories ?? [] as string[]).filter((entry) => typeof entry === "string") as string[])].sort(
        (left, right) => left.localeCompare(right)
      ),
      updatedAt: value?.updatedAt ?? null
    };

    await this.pool.query(
      `
        INSERT INTO category_catalogs (scope, updated_at, payload)
        VALUES ($1, $2, $3::jsonb)
        ON CONFLICT (scope) DO UPDATE
        SET updated_at = EXCLUDED.updated_at,
            payload = EXCLUDED.payload
      `,
      [scope, payload.updatedAt, JSON.stringify(payload)]
    );
    return payload;
  }
}

export class PostgresTradeActivityRepository {
  private pool: Pool;
  constructor(pool) {
    this.pool = pool;
  }

  async findByEventId(eventId) {
    const result = await this.pool.query(
      `SELECT payload FROM trade_activity WHERE event_id = $1 LIMIT 1`,
      [eventId]
    );
    return parsePayloadRow(result.rows[0]);
  }

  async upsert(activity) {
    await this.pool.query(
      `
        INSERT INTO trade_activity (event_id, last_trade_at, last_fetched_at, payload)
        VALUES ($1, $2, $3, $4::jsonb)
        ON CONFLICT (event_id) DO UPDATE
        SET last_trade_at = EXCLUDED.last_trade_at,
            last_fetched_at = EXCLUDED.last_fetched_at,
            payload = EXCLUDED.payload
      `,
      [
        activity.eventId,
        activity.lastTradeAt ?? null,
        activity.lastFetchedAt ?? null,
        JSON.stringify(activity)
      ]
    );
    return activity;
  }
}

export class PostgresPhase1Coordinator {
  private pool: Pool;
  private clarificationRequestRepository: PostgresClarificationRequestRepository;
  private verifiedPaymentRepository: PostgresVerifiedPaymentRepository;
  private backgroundJobRepository: PostgresBackgroundJobRepository;
  constructor({
    pool,
    clarificationRequestRepository,
    verifiedPaymentRepository,
    backgroundJobRepository
  }) {
    this.pool = pool;
    this.clarificationRequestRepository = clarificationRequestRepository;
    this.verifiedPaymentRepository = verifiedPaymentRepository;
    this.backgroundJobRepository = backgroundJobRepository;
  }

  async createPaidClarification({ clarification, verifiedPayment, backgroundJob }) {
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");

      const existingClarificationResult = await client.query(
        `SELECT payload FROM clarifications WHERE payment_proof = $1 LIMIT 1`,
        [verifiedPayment.paymentProof]
      );
      const existingClarification = parsePayloadRow(existingClarificationResult.rows[0]);

      if (existingClarification) {
        await client.query("COMMIT");
        return {
          created: false,
          clarification: existingClarification,
          job: null
        };
      }

      await this.verifiedPaymentRepository.create(
        {
          ...verifiedPayment,
          createdAt: verifiedPayment.createdAt ?? clarification.createdAt,
          updatedAt: verifiedPayment.updatedAt ?? clarification.updatedAt
        },
        client
      );
      await this.clarificationRequestRepository.create(clarification, client);
      await this.backgroundJobRepository.create(backgroundJob, client);
      await this.verifiedPaymentRepository.updateByPaymentProof(
        verifiedPayment.paymentProof,
        {
          clarificationId: clarification.clarificationId,
          updatedAt: clarification.updatedAt
        },
        client
      );

      await client.query("COMMIT");
      return {
        created: true,
        clarification,
        job: backgroundJob
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

export function loadPostgresRuntimeConfig(env = process.env) {
  return {
    connectionString: env.DATABASE_URL ?? null,
    ssl: env.PGSSLMODE === "require" || parseBooleanEnv(String(env.PGSSL ?? "").toLowerCase())
  };
}
