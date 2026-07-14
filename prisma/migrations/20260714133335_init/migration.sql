-- CreateEnum
CREATE TYPE "Role" AS ENUM ('OWNER', 'EDITOR', 'VIEWER');

-- CreateEnum
CREATE TYPE "OperationType" AS ENUM ('BLOCK_INSERT', 'BLOCK_REMOVE', 'BLOCK_MOVE', 'BLOCK_SET_ATTRS', 'TEXT_INSERT', 'TEXT_DELETE', 'MARK_SET');

-- CreateEnum
CREATE TYPE "VersionKind" AS ENUM ('AUTO', 'NAMED', 'RESTORE', 'SNAPSHOT');

-- CreateEnum
CREATE TYPE "FailureReason" AS ENUM ('VALIDATION_FAILED', 'PAYLOAD_TOO_LARGE', 'UNAUTHORIZED', 'DOCUMENT_DELETED', 'CONFLICT', 'RATE_LIMITED', 'INTERNAL');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('DOCUMENT_CREATED', 'DOCUMENT_DELETED', 'DOCUMENT_RESTORED', 'COLLABORATOR_INVITED', 'COLLABORATOR_ROLE_CHANGED', 'COLLABORATOR_REMOVED', 'VERSION_CREATED', 'VERSION_RESTORED', 'AI_INVOKED', 'AUTH_LOGIN_SUCCEEDED', 'AUTH_LOGIN_FAILED', 'UNAUTHORIZED_ACCESS_ATTEMPT');

-- CreateEnum
CREATE TYPE "AiAction" AS ENUM ('REWRITE', 'IMPROVE', 'SUMMARIZE', 'TRANSLATE', 'FIX_GRAMMAR', 'CHANGE_TONE', 'MEETING_NOTES', 'ACTION_ITEMS', 'CONTINUE_WRITING', 'EXPLAIN', 'GENERATE_TITLE', 'DOCUMENT_INSIGHTS');

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "image" TEXT,
    "emailVerified" TIMESTAMP(3),
    "passwordHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounts" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "expiresAt" INTEGER,
    "tokenType" TEXT,
    "scope" TEXT,
    "idToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documents" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT 'Untitled',
    "ownerId" TEXT NOT NULL,
    "serverSeq" BIGINT NOT NULL DEFAULT 0,
    "snapshotSeq" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "collaborators" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'VIEWER',
    "invitedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "collaborators_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "operations" (
    "operationId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "serverSeq" BIGINT NOT NULL,
    "logicalClock" INTEGER NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "documentVersion" BIGINT NOT NULL,
    "operationType" "OperationType" NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "operations_pkey" PRIMARY KEY ("operationId")
);

-- CreateTable
CREATE TABLE "versions" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "kind" "VersionKind" NOT NULL,
    "label" TEXT,
    "description" TEXT,
    "content" JSONB NOT NULL,
    "serverSeq" BIGINT NOT NULL,
    "parentVersionId" TEXT,
    "blockCount" INTEGER NOT NULL DEFAULT 0,
    "charCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_sessions" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "lastAckedSeq" BIGINT NOT NULL DEFAULT 0,
    "lastPushedSeq" BIGINT NOT NULL DEFAULT 0,
    "opsPushed" INTEGER NOT NULL DEFAULT 0,
    "opsPulled" INTEGER NOT NULL DEFAULT 0,
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "disconnectedAt" TIMESTAMP(3),

    CONSTRAINT "sync_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "failed_operations" (
    "id" TEXT NOT NULL,
    "operationId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "reason" "FailureReason" NOT NULL,
    "message" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "failed_operations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "key" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "rate_limits" (
    "key" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "rate_limits_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "action" "AuditAction" NOT NULL,
    "actorId" TEXT,
    "targetId" TEXT,
    "metadata" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_history" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "documentId" TEXT,
    "action" "AiAction" NOT NULL,
    "model" TEXT NOT NULL,
    "prompt" TEXT,
    "inputChars" INTEGER NOT NULL DEFAULT 0,
    "output" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_deletedAt_idx" ON "users"("deletedAt");

-- CreateIndex
CREATE INDEX "accounts_userId_idx" ON "accounts"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "accounts_provider_providerAccountId_key" ON "accounts"("provider", "providerAccountId");

-- CreateIndex
CREATE INDEX "documents_by_owner" ON "documents"("ownerId", "deletedAt");

-- CreateIndex
CREATE INDEX "documents_recent" ON "documents"("deletedAt", "updatedAt" DESC);

-- CreateIndex
CREATE INDEX "collaborators_by_user" ON "collaborators"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "collaborators_documentId_userId_key" ON "collaborators"("documentId", "userId");

-- CreateIndex
CREATE INDEX "operations_pull_cursor" ON "operations"("documentId", "serverSeq");

-- CreateIndex
CREATE INDEX "operations_by_author" ON "operations"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "operations_documentId_serverSeq_key" ON "operations"("documentId", "serverSeq");

-- CreateIndex
CREATE INDEX "versions_timeline" ON "versions"("documentId", "serverSeq" DESC);

-- CreateIndex
CREATE INDEX "versions_by_kind" ON "versions"("documentId", "kind");

-- CreateIndex
CREATE INDEX "sync_sessions_watermark" ON "sync_sessions"("documentId", "lastAckedSeq");

-- CreateIndex
CREATE INDEX "sync_sessions_by_user" ON "sync_sessions"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "sync_sessions_documentId_clientId_key" ON "sync_sessions"("documentId", "clientId");

-- CreateIndex
CREATE INDEX "failed_ops_by_document" ON "failed_operations"("documentId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "failed_ops_by_user" ON "failed_operations"("userId", "resolvedAt");

-- CreateIndex
CREATE INDEX "idempotency_gc" ON "idempotency_keys"("expiresAt");

-- CreateIndex
CREATE INDEX "rate_limits_gc" ON "rate_limits"("windowStart");

-- CreateIndex
CREATE INDEX "audit_by_actor" ON "audit_logs"("actorId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "audit_by_target" ON "audit_logs"("targetId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "audit_by_action" ON "audit_logs"("action", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ai_history_by_user" ON "ai_history"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ai_history_by_document" ON "ai_history"("documentId", "createdAt" DESC);

-- AddForeignKey
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collaborators" ADD CONSTRAINT "collaborators_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "collaborators" ADD CONSTRAINT "collaborators_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operations" ADD CONSTRAINT "operations_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "operations" ADD CONSTRAINT "operations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "versions" ADD CONSTRAINT "versions_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "versions" ADD CONSTRAINT "versions_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "versions" ADD CONSTRAINT "versions_parentVersionId_fkey" FOREIGN KEY ("parentVersionId") REFERENCES "versions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_sessions" ADD CONSTRAINT "sync_sessions_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_sessions" ADD CONSTRAINT "sync_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "failed_operations" ADD CONSTRAINT "failed_operations_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_history" ADD CONSTRAINT "ai_history_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_history" ADD CONSTRAINT "ai_history_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
