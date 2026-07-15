-- One-time email codes: sign-up verification and password reset.
--
-- The code itself is never stored — only an HMAC of it, keyed by the server secret (see
-- services/otp.service.ts). A 6-digit code is ~20 bits of entropy, so a plain hash in a leaked
-- table is reversible instantly; the keyed MAC means a dump alone reveals no live code. The online
-- brute-force defence is the attempts cap plus the short expiry, enforced at verify time.

-- CreateEnum
CREATE TYPE "VerificationPurpose" AS ENUM ('EMAIL_VERIFY', 'PASSWORD_RESET');

-- CreateTable
CREATE TABLE "verification_tokens" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "purpose" "VerificationPurpose" NOT NULL,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "verification_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "verification_tokens_lookup" ON "verification_tokens"("email", "purpose");

-- CreateIndex
CREATE INDEX "verification_tokens_gc" ON "verification_tokens"("expiresAt");
