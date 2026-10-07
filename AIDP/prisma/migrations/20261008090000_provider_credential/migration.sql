-- A company's own model key.
--
-- Per organisation and generation only. Embeddings stay on the deployment's
-- key: the corpus is indexed by embedding model name, and a company that
-- switched would lose dense retrieval over everything already ingested without
-- a single error being raised.
--
-- No row is the normal state and means the environment's key does the work,
-- which is what every organisation did before this table existed. Nothing here
-- changes behaviour for an organisation that never visits the page.
CREATE TABLE "provider_credential" (
    "id"                  TEXT NOT NULL,
    "organisationId"      TEXT NOT NULL,
    "provider"            TEXT NOT NULL,
    -- AES-256-GCM, base64, organisation id as additional authenticated data.
    "ciphertext"          TEXT NOT NULL,
    "keyLast4"            TEXT NOT NULL,
    "model"               TEXT NOT NULL,
    "fastModel"           TEXT NOT NULL,
    "openrouterProviders" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "zdr"                 BOOLEAN NOT NULL DEFAULT false,
    "active"              BOOLEAN NOT NULL DEFAULT true,
    "probe"               JSONB,
    "probedAt"            TIMESTAMP(3),
    "setById"             TEXT,
    "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"           TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_credential_pkey" PRIMARY KEY ("id")
);

-- One live key per company. Two rows would mean two answers to "which model
-- judged this", settled by whichever the query returned first.
CREATE UNIQUE INDEX "provider_credential_organisationId_key"
    ON "provider_credential" ("organisationId");

ALTER TABLE "provider_credential"
    ADD CONSTRAINT "provider_credential_organisationId_fkey"
    FOREIGN KEY ("organisationId") REFERENCES "organisation" ("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- The administrator who installed it may leave; the key belongs to the company
-- and stays behind.
ALTER TABLE "provider_credential"
    ADD CONSTRAINT "provider_credential_setById_fkey"
    FOREIGN KEY ("setById") REFERENCES "user" ("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Which key the provider billed.
--
-- Every existing row was paid for by the deployment's own key, so the default
-- is correct for the whole table as it stands. Without this column the operator
-- console reads a customer's own provider bill as the platform's spend: it
-- overstates what the product costs to run, and it invites billing a customer
-- for tokens they have already paid for directly.
ALTER TABLE "token_usage" ADD COLUMN "payer" TEXT NOT NULL DEFAULT 'platform';
