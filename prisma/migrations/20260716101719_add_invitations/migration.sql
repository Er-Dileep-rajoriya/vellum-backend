-- CreateEnum
CREATE TYPE "InvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED', 'REVOKED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AuditAction" ADD VALUE 'INVITATION_ACCEPTED';
ALTER TYPE "AuditAction" ADD VALUE 'INVITATION_DECLINED';
ALTER TYPE "AuditAction" ADD VALUE 'INVITATION_REVOKED';

-- CreateTable
CREATE TABLE "invitations" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" "InvitationStatus" NOT NULL DEFAULT 'PENDING',
    "invitedById" TEXT NOT NULL,
    "acceptedById" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invitations_tokenHash_key" ON "invitations"("tokenHash");

-- CreateIndex
CREATE INDEX "invitations_by_email" ON "invitations"("email", "status");

-- CreateIndex
CREATE INDEX "invitations_gc" ON "invitations"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "invitations_documentId_email_key" ON "invitations"("documentId", "email");

-- AddForeignKey
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
