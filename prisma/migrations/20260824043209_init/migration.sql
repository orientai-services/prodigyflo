-- CreateEnum
CREATE TYPE "RoleKey" AS ENUM ('SUPER_ADMIN', 'ADMIN', 'REGIONAL_MANAGER', 'SALES_MANAGER', 'CLOSER', 'DOCUMENT_COLLECTOR', 'MARKETING', 'CLIENT');

-- CreateEnum
CREATE TYPE "StageKey" AS ENUM ('NEW_LEAD', 'SURVEY_STARTED', 'SURVEY_COMPLETED', 'INFO_VERIFICATION', 'CONSENT_PENDING', 'CREDIT_PULL_PENDING', 'CREDIT_PULL_COMPLETED', 'QUALIFICATION_REVIEW', 'QUALIFIED', 'NOT_QUALIFIED', 'APPOINTMENT_SCHEDULING', 'APPOINTMENT_SCHEDULED', 'PRESENTATION_COMPLETED', 'FOLLOW_UP', 'PAYMENT_SELECTION', 'DOCUMENT_COLLECTION', 'COMMUNICATION_EVIDENCE_REVIEW', 'ATTORNEY_DOCUMENT_REVIEW', 'DEAL_READY_FOR_SUBMISSION', 'SUBMITTED', 'CORRECTIONS_REQUESTED', 'APPROVED', 'CLOSED_WON', 'CLOSED_LOST', 'ON_HOLD');

-- CreateEnum
CREATE TYPE "StageCategory" AS ENUM ('INTAKE', 'QUALIFICATION', 'SALES', 'FULFILLMENT', 'SUBMISSION', 'TERMINAL');

-- CreateEnum
CREATE TYPE "ClientStatus" AS ENUM ('ACTIVE', 'ON_HOLD', 'DISQUALIFIED', 'CLOSED_WON', 'CLOSED_LOST');

-- CreateEnum
CREATE TYPE "SurveyStatus" AS ENUM ('NOT_STARTED', 'IN_PROGRESS', 'COMPLETED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "ConsentType" AS ENUM ('SOFT_CREDIT_PULL', 'ELECTRONIC_COMMUNICATION', 'TCPA_CONTACT', 'PRIVACY_POLICY', 'ESIGN_DISCLOSURE', 'DOCUMENT_RELEASE');

-- CreateEnum
CREATE TYPE "VerificationType" AS ENUM ('EMAIL', 'PHONE', 'IDENTITY', 'ADDRESS');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('PENDING', 'VERIFIED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "CreditPullStatus" AS ENUM ('NOT_REQUESTED', 'CONSENT_REQUIRED', 'PENDING', 'COMPLETED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "QualificationOutcome" AS ENUM ('QUALIFIED', 'NOT_QUALIFIED', 'NEEDS_MORE_INFO', 'PENDING');

-- CreateEnum
CREATE TYPE "AppointmentType" AS ENUM ('DISCOVERY', 'PRESENTATION', 'FOLLOW_UP', 'DOCUMENT_REVIEW', 'CLOSING');

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('SCHEDULED', 'CONFIRMED', 'COMPLETED', 'NO_SHOW', 'CANCELLED', 'RESCHEDULED');

-- CreateEnum
CREATE TYPE "PaymentPath" AS ENUM ('CASH', 'CARD', 'ACH', 'FINANCING', 'UNDECIDED');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('NOT_STARTED', 'PENDING', 'DEPOSIT_PAID', 'PAID_IN_FULL', 'FAILED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "FinancingStatus" AS ENUM ('NOT_SUBMITTED', 'SUBMITTED', 'PENDING', 'APPROVED', 'DECLINED', 'ADDITIONAL_INFO_REQUIRED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('REQUESTED', 'RECEIVED', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "DocumentCategory" AS ENUM ('COMMUNICATION_EVIDENCE', 'ATTORNEY_REQUIRED', 'CONTRACT', 'IDENTITY', 'INCOME', 'OTHER');

-- CreateEnum
CREATE TYPE "CommunicationChannel" AS ENUM ('CALL', 'SMS', 'IMESSAGE', 'EMAIL', 'PORTAL_MESSAGE', 'MESSENGER', 'IN_PERSON', 'NOTE');

-- CreateEnum
CREATE TYPE "CommunicationDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "CommunicationStatus" AS ENUM ('QUEUED', 'SENT', 'DELIVERED', 'READ', 'FAILED', 'RECEIVED');

-- CreateEnum
CREATE TYPE "CallOutcome" AS ENUM ('CONNECTED', 'VOICEMAIL', 'NO_ANSWER', 'BUSY', 'WRONG_NUMBER', 'DECLINED', 'FAILED');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "SubmissionDestination" AS ENUM ('CYS', 'ATTORNEY');

-- CreateEnum
CREATE TYPE "SubmissionStatus" AS ENUM ('DRAFT', 'READY', 'SUBMITTED', 'ACKNOWLEDGED', 'CORRECTIONS_REQUESTED', 'RESUBMITTED', 'APPROVED', 'REJECTED');

-- CreateEnum
CREATE TYPE "DealStatus" AS ENUM ('OPEN', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "AIRecommendationType" AS ENUM ('ONBOARDING_ANALYSIS', 'QUALIFICATION', 'CLOSER_ASSIGNMENT', 'NEXT_BEST_ACTION', 'FOLLOW_UP_DRAFT');

-- CreateEnum
CREATE TYPE "AIRecommendationStatus" AS ENUM ('PENDING_REVIEW', 'ACCEPTED', 'OVERRIDDEN', 'DISMISSED');

-- CreateEnum
CREATE TYPE "ConnectorKind" AS ENUM ('CREDIT_BUREAU', 'TWILIO_VOICE', 'TWILIO_SMS', 'IMESSAGE', 'EMAIL', 'CALENDAR', 'META_ADS', 'PAYMENT', 'FINANCING', 'CYS', 'ATTORNEY', 'FILE_STORAGE', 'AI_PROVIDER');

-- CreateEnum
CREATE TYPE "ConnectorStatus" AS ENUM ('NOT_CONFIGURED', 'MOCK', 'CONNECTED', 'ERROR', 'DISABLED');

-- CreateEnum
CREATE TYPE "AttributionTouch" AS ENUM ('FIRST', 'LAST', 'MIDDLE');

-- CreateEnum
CREATE TYPE "NotificationKind" AS ENUM ('ASSIGNMENT', 'APPOINTMENT', 'DOCUMENT', 'SUBMISSION', 'SLA_WARNING', 'MESSAGE', 'SYSTEM');

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/Los_Angeles',
    "settings" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Region" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/Los_Angeles',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Region_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Team" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "regionId" TEXT,
    "name" TEXT NOT NULL,
    "managerId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Permission" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,

    CONSTRAINT "Permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Role" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" "RoleKey" NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isSystem" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RolePermission" (
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,

    CONSTRAINT "RolePermission_pkey" PRIMARY KEY ("roleId","permissionId")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "regionId" TEXT,
    "teamId" TEXT,
    "managerId" TEXT,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "avatarUrl" TEXT,
    "title" TEXT,
    "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "licensedIn" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "specialties" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "maxWorkload" INTEGER NOT NULL DEFAULT 40,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSession" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "UserSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pipeline" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Pipeline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PipelineStage" (
    "id" TEXT NOT NULL,
    "pipelineId" TEXT NOT NULL,
    "key" "StageKey" NOT NULL,
    "name" TEXT NOT NULL,
    "category" "StageCategory" NOT NULL,
    "position" INTEGER NOT NULL,
    "slaHours" INTEGER,
    "isTerminal" BOOLEAN NOT NULL DEFAULT false,
    "requiredFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "checklist" JSONB NOT NULL DEFAULT '[]',
    "allowedNextKeys" "StageKey"[] DEFAULT ARRAY[]::"StageKey"[],
    "autoAdvance" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT,

    CONSTRAINT "PipelineStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StageHistory" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "fromKey" "StageKey",
    "toKey" "StageKey" NOT NULL,
    "enteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exitedAt" TIMESTAMP(3),
    "durationMinutes" INTEGER,
    "changedById" TEXT,
    "automated" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "note" TEXT,

    CONSTRAINT "StageHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "pipelineId" TEXT NOT NULL,
    "currentStageId" TEXT NOT NULL,
    "regionId" TEXT,
    "teamId" TEXT,
    "ownerId" TEXT,
    "portalUserId" TEXT,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "preferredLanguage" TEXT NOT NULL DEFAULT 'en',
    "preferredContact" TEXT NOT NULL DEFAULT 'phone',
    "status" "ClientStatus" NOT NULL DEFAULT 'ACTIVE',
    "leadSourceId" TEXT,
    "campaignId" TEXT,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "utmTerm" TEXT,
    "utmContent" TEXT,
    "estimatedValue" DECIMAL(12,2),
    "probability" INTEGER,
    "expectedCloseAt" TIMESTAMP(3),
    "lostReason" TEXT,
    "holdReason" TEXT,
    "disqualifiedReason" TEXT,
    "stageEnteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstContactAt" TIMESTAMP(3),
    "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientAddress" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "label" TEXT NOT NULL DEFAULT 'primary',
    "line1" TEXT NOT NULL,
    "line2" TEXT,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "postalCode" TEXT NOT NULL,
    "country" TEXT NOT NULL DEFAULT 'US',
    "isPrimary" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Survey" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "schema" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Survey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SurveyResponse" (
    "id" TEXT NOT NULL,
    "surveyId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "status" "SurveyStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "currentStep" INTEGER NOT NULL DEFAULT 0,
    "answers" JSONB NOT NULL DEFAULT '{}',
    "resumeTokenHash" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "abandonedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SurveyResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Consent" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "type" "ConsentType" NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "textVersion" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "Consent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Verification" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "type" "VerificationType" NOT NULL,
    "status" "VerificationStatus" NOT NULL DEFAULT 'PENDING',
    "value" TEXT,
    "maskedValue" TEXT,
    "method" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "verifiedById" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditPull" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "consentId" TEXT,
    "provider" TEXT NOT NULL DEFAULT 'mock',
    "status" "CreditPullStatus" NOT NULL DEFAULT 'NOT_REQUESTED',
    "permissiblePurpose" TEXT,
    "scoreBand" TEXT,
    "scoreRangeLow" INTEGER,
    "scoreRangeHigh" INTEGER,
    "tradelines" INTEGER,
    "derogatoryMarks" INTEGER,
    "utilizationPct" INTEGER,
    "monthlyObligations" DECIMAL(12,2),
    "externalRef" TEXT,
    "requestedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditPull_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QualificationReview" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "outcome" "QualificationOutcome" NOT NULL DEFAULT 'PENDING',
    "reviewerId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "aiRecommendedOutcome" "QualificationOutcome",
    "aiConfidence" INTEGER,
    "aiReasons" JSONB NOT NULL DEFAULT '[]',
    "missingEvidence" JSONB NOT NULL DEFAULT '[]',
    "rulesEvaluated" JSONB NOT NULL DEFAULT '[]',
    "overrideReason" TEXT,
    "decisionNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QualificationReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Contract" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "counterparty" TEXT NOT NULL,
    "productType" TEXT,
    "signedAt" TIMESTAMP(3),
    "termMonths" INTEGER,
    "monthlyAmount" DECIMAL(12,2),
    "totalAmount" DECIMAL(12,2),
    "escalatorPct" DECIMAL(5,2),
    "documentId" TEXT,
    "extractedFields" JSONB NOT NULL DEFAULT '{}',
    "extractionSource" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Contract_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Assignment" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "assigneeId" TEXT NOT NULL,
    "assignedById" TEXT,
    "role" "RoleKey" NOT NULL DEFAULT 'CLOSER',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT,
    "aiRecommendationId" TEXT,
    "wasOverride" BOOLEAN NOT NULL DEFAULT false,
    "overrideReason" TEXT,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unassignedAt" TIMESTAMP(3),

    CONSTRAINT "Assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AvailabilitySlot" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "startMinute" INTEGER NOT NULL,
    "endMinute" INTEGER NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/Los_Angeles',

    CONSTRAINT "AvailabilitySlot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Appointment" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "type" "AppointmentType" NOT NULL DEFAULT 'PRESENTATION',
    "status" "AppointmentStatus" NOT NULL DEFAULT 'SCHEDULED',
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/Los_Angeles',
    "location" TEXT,
    "meetingUrl" TEXT,
    "externalEventId" TEXT,
    "calendarConnectorId" TEXT,
    "reminderSentAt" TIMESTAMP(3),
    "confirmedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "rescheduledFromId" TEXT,
    "outcome" TEXT,
    "outcomeNotes" TEXT,
    "noShowRecordedAt" TIMESTAMP(3),
    "prepBrief" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Presentation" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "appointmentId" TEXT,
    "presenterId" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3),
    "checklist" JSONB NOT NULL DEFAULT '[]',
    "materialsUrl" TEXT,
    "notes" TEXT,
    "objections" JSONB NOT NULL DEFAULT '[]',
    "followUpAt" TIMESTAMP(3),
    "followUpNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Presentation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentMethod" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "path" "PaymentPath" NOT NULL DEFAULT 'UNDECIDED',
    "status" "PaymentStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "provider" TEXT,
    "providerToken" TEXT,
    "brand" TEXT,
    "last4" TEXT,
    "expMonth" INTEGER,
    "expYear" INTEGER,
    "amount" DECIMAL(12,2),
    "depositAmount" DECIMAL(12,2),
    "receiptRef" TEXT,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "selectedAt" TIMESTAMP(3),
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentMethod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinancingApplication" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'mock',
    "status" "FinancingStatus" NOT NULL DEFAULT 'NOT_SUBMITTED',
    "requestedAmount" DECIMAL(12,2),
    "approvedAmount" DECIMAL(12,2),
    "termMonths" INTEGER,
    "aprPct" DECIMAL(5,2),
    "monthlyPayment" DECIMAL(12,2),
    "externalRef" TEXT,
    "decisionAt" TIMESTAMP(3),
    "decisionReason" TEXT,
    "additionalInfoRequested" JSONB NOT NULL DEFAULT '[]',
    "submittedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FinancingApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentPackage" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DocumentPackage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentRequirement" (
    "id" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" "DocumentCategory" NOT NULL DEFAULT 'OTHER',
    "description" TEXT,
    "isRequired" BOOLEAN NOT NULL DEFAULT true,
    "isAttorneyRequired" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL DEFAULT 0,
    "allowedMimeTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "maxSizeMb" INTEGER NOT NULL DEFAULT 25,
    "expiresAfterDays" INTEGER,

    CONSTRAINT "DocumentRequirement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientDocument" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "requirementId" TEXT,
    "collectorId" TEXT,
    "status" "DocumentStatus" NOT NULL DEFAULT 'REQUESTED',
    "version" INTEGER NOT NULL DEFAULT 1,
    "supersedesId" TEXT,
    "fileName" TEXT,
    "storageKey" TEXT,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "checksum" TEXT,
    "scanStatus" TEXT NOT NULL DEFAULT 'pending',
    "label" TEXT,
    "clientVisibleComment" TEXT,
    "internalComment" TEXT,
    "rejectionReason" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "slaDueAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClientDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentReview" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "reviewerId" TEXT NOT NULL,
    "decision" "DocumentStatus" NOT NULL,
    "reason" TEXT,
    "reviewedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Communication" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" TEXT,
    "channel" "CommunicationChannel" NOT NULL,
    "direction" "CommunicationDirection" NOT NULL,
    "status" "CommunicationStatus" NOT NULL DEFAULT 'SENT',
    "subject" TEXT,
    "body" TEXT,
    "isInternal" BOOLEAN NOT NULL DEFAULT false,
    "templateKey" TEXT,
    "connectorId" TEXT,
    "externalRef" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Communication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Call" (
    "id" TEXT NOT NULL,
    "communicationId" TEXT NOT NULL,
    "fromMasked" TEXT,
    "toMasked" TEXT,
    "durationSeconds" INTEGER NOT NULL DEFAULT 0,
    "outcome" "CallOutcome" NOT NULL DEFAULT 'CONNECTED',
    "recordingRef" TEXT,
    "recordingDurationSeconds" INTEGER,
    "voicemailLeft" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Call_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL,
    "communicationId" TEXT NOT NULL,
    "fromMasked" TEXT,
    "toMasked" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "failureCode" TEXT,
    "optOutDetected" BOOLEAN NOT NULL DEFAULT false,
    "attachments" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "assigneeId" TEXT,
    "createdById" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "TaskPriority" NOT NULL DEFAULT 'NORMAL',
    "dueAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "stageKey" "StageKey",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Note" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "authorId" TEXT,
    "body" TEXT NOT NULL,
    "isInternal" BOOLEAN NOT NULL DEFAULT true,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadSource" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "leadSourceId" TEXT,
    "name" TEXT NOT NULL,
    "externalId" TEXT,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "budget" DECIMAL(12,2),
    "spend" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "utmCampaign" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttributionEvent" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "campaignId" TEXT,
    "leadSourceId" TEXT,
    "touch" "AttributionTouch" NOT NULL DEFAULT 'MIDDLE',
    "channel" TEXT,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "referrer" TEXT,
    "landingPath" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttributionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Deal" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "status" "DealStatus" NOT NULL DEFAULT 'OPEN',
    "value" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "probability" INTEGER NOT NULL DEFAULT 0,
    "expectedCloseAt" TIMESTAMP(3),
    "wonAt" TIMESTAMP(3),
    "lostAt" TIMESTAMP(3),
    "lostReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Deal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Submission" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "dealId" TEXT,
    "destination" "SubmissionDestination" NOT NULL DEFAULT 'CYS',
    "status" "SubmissionStatus" NOT NULL DEFAULT 'DRAFT',
    "connectorId" TEXT,
    "externalRef" TEXT,
    "packageManifest" JSONB NOT NULL DEFAULT '[]',
    "validationReport" JSONB NOT NULL DEFAULT '{}',
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "submittedAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "correctionsRequested" JSONB NOT NULL DEFAULT '[]',
    "correctionsRequestedAt" TIMESTAMP(3),
    "resubmittedAt" TIMESTAMP(3),
    "rejectionReason" TEXT,
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AIRecommendation" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "type" "AIRecommendationType" NOT NULL,
    "status" "AIRecommendationStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "provider" TEXT NOT NULL DEFAULT 'mock',
    "model" TEXT,
    "summary" TEXT,
    "facts" JSONB NOT NULL DEFAULT '[]',
    "inferences" JSONB NOT NULL DEFAULT '[]',
    "recommendation" JSONB NOT NULL DEFAULT '{}',
    "confidence" INTEGER,
    "reasons" JSONB NOT NULL DEFAULT '[]',
    "missingInformation" JSONB NOT NULL DEFAULT '[]',
    "complianceFlags" JSONB NOT NULL DEFAULT '[]',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "overrideReason" TEXT,
    "promptTokens" INTEGER,
    "completionTokens" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AIRecommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Connector" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" "ConnectorKind" NOT NULL,
    "name" TEXT NOT NULL,
    "status" "ConnectorStatus" NOT NULL DEFAULT 'MOCK',
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "config" JSONB NOT NULL DEFAULT '{}',
    "secretRef" TEXT,
    "fieldMapping" JSONB NOT NULL DEFAULT '{}',
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncStatus" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "lastError" TEXT,
    "webhookUrl" TEXT,
    "webhookHealthy" BOOLEAN NOT NULL DEFAULT true,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Connector_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectorLog" (
    "id" TEXT NOT NULL,
    "connectorId" TEXT NOT NULL,
    "level" TEXT NOT NULL DEFAULT 'info',
    "event" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConnectorLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "NotificationKind" NOT NULL DEFAULT 'SYSTEM',
    "title" TEXT NOT NULL,
    "body" TEXT,
    "href" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "actorId" TEXT,
    "actorLabel" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "summary" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE INDEX "Region_organizationId_idx" ON "Region"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Region_organizationId_code_key" ON "Region"("organizationId", "code");

-- CreateIndex
CREATE INDEX "Team_organizationId_idx" ON "Team"("organizationId");

-- CreateIndex
CREATE INDEX "Team_regionId_idx" ON "Team"("regionId");

-- CreateIndex
CREATE UNIQUE INDEX "Permission_key_key" ON "Permission"("key");

-- CreateIndex
CREATE INDEX "Role_organizationId_idx" ON "Role"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Role_organizationId_key_key" ON "Role"("organizationId", "key");

-- CreateIndex
CREATE INDEX "User_organizationId_idx" ON "User"("organizationId");

-- CreateIndex
CREATE INDEX "User_teamId_idx" ON "User"("teamId");

-- CreateIndex
CREATE INDEX "User_regionId_idx" ON "User"("regionId");

-- CreateIndex
CREATE INDEX "User_managerId_idx" ON "User"("managerId");

-- CreateIndex
CREATE UNIQUE INDEX "User_organizationId_email_key" ON "User"("organizationId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "UserSession_tokenHash_key" ON "UserSession"("tokenHash");

-- CreateIndex
CREATE INDEX "UserSession_userId_idx" ON "UserSession"("userId");

-- CreateIndex
CREATE INDEX "Pipeline_organizationId_idx" ON "Pipeline"("organizationId");

-- CreateIndex
CREATE INDEX "PipelineStage_pipelineId_idx" ON "PipelineStage"("pipelineId");

-- CreateIndex
CREATE UNIQUE INDEX "PipelineStage_pipelineId_key_key" ON "PipelineStage"("pipelineId", "key");

-- CreateIndex
CREATE INDEX "StageHistory_clientId_idx" ON "StageHistory"("clientId");

-- CreateIndex
CREATE INDEX "StageHistory_stageId_idx" ON "StageHistory"("stageId");

-- CreateIndex
CREATE UNIQUE INDEX "Client_portalUserId_key" ON "Client"("portalUserId");

-- CreateIndex
CREATE INDEX "Client_organizationId_idx" ON "Client"("organizationId");

-- CreateIndex
CREATE INDEX "Client_currentStageId_idx" ON "Client"("currentStageId");

-- CreateIndex
CREATE INDEX "Client_ownerId_idx" ON "Client"("ownerId");

-- CreateIndex
CREATE INDEX "Client_teamId_idx" ON "Client"("teamId");

-- CreateIndex
CREATE INDEX "Client_regionId_idx" ON "Client"("regionId");

-- CreateIndex
CREATE INDEX "Client_organizationId_status_idx" ON "Client"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Client_campaignId_idx" ON "Client"("campaignId");

-- CreateIndex
CREATE INDEX "Client_leadSourceId_idx" ON "Client"("leadSourceId");

-- CreateIndex
CREATE INDEX "ClientAddress_clientId_idx" ON "ClientAddress"("clientId");

-- CreateIndex
CREATE INDEX "Survey_organizationId_idx" ON "Survey"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "SurveyResponse_resumeTokenHash_key" ON "SurveyResponse"("resumeTokenHash");

-- CreateIndex
CREATE INDEX "SurveyResponse_clientId_idx" ON "SurveyResponse"("clientId");

-- CreateIndex
CREATE INDEX "SurveyResponse_surveyId_idx" ON "SurveyResponse"("surveyId");

-- CreateIndex
CREATE INDEX "Consent_clientId_type_idx" ON "Consent"("clientId", "type");

-- CreateIndex
CREATE INDEX "Verification_clientId_idx" ON "Verification"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "Verification_clientId_type_key" ON "Verification"("clientId", "type");

-- CreateIndex
CREATE INDEX "CreditPull_clientId_idx" ON "CreditPull"("clientId");

-- CreateIndex
CREATE INDEX "QualificationReview_clientId_idx" ON "QualificationReview"("clientId");

-- CreateIndex
CREATE INDEX "Contract_clientId_idx" ON "Contract"("clientId");

-- CreateIndex
CREATE INDEX "Assignment_clientId_idx" ON "Assignment"("clientId");

-- CreateIndex
CREATE INDEX "Assignment_assigneeId_idx" ON "Assignment"("assigneeId");

-- CreateIndex
CREATE INDEX "AvailabilitySlot_userId_idx" ON "AvailabilitySlot"("userId");

-- CreateIndex
CREATE INDEX "Appointment_clientId_idx" ON "Appointment"("clientId");

-- CreateIndex
CREATE INDEX "Appointment_ownerId_idx" ON "Appointment"("ownerId");

-- CreateIndex
CREATE INDEX "Appointment_startsAt_idx" ON "Appointment"("startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "Presentation_appointmentId_key" ON "Presentation"("appointmentId");

-- CreateIndex
CREATE INDEX "Presentation_clientId_idx" ON "Presentation"("clientId");

-- CreateIndex
CREATE INDEX "PaymentMethod_clientId_idx" ON "PaymentMethod"("clientId");

-- CreateIndex
CREATE INDEX "FinancingApplication_clientId_idx" ON "FinancingApplication"("clientId");

-- CreateIndex
CREATE INDEX "DocumentPackage_organizationId_idx" ON "DocumentPackage"("organizationId");

-- CreateIndex
CREATE INDEX "DocumentRequirement_packageId_idx" ON "DocumentRequirement"("packageId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentRequirement_packageId_key_key" ON "DocumentRequirement"("packageId", "key");

-- CreateIndex
CREATE INDEX "ClientDocument_clientId_idx" ON "ClientDocument"("clientId");

-- CreateIndex
CREATE INDEX "ClientDocument_collectorId_idx" ON "ClientDocument"("collectorId");

-- CreateIndex
CREATE INDEX "ClientDocument_status_idx" ON "ClientDocument"("status");

-- CreateIndex
CREATE INDEX "DocumentReview_documentId_idx" ON "DocumentReview"("documentId");

-- CreateIndex
CREATE INDEX "Communication_clientId_idx" ON "Communication"("clientId");

-- CreateIndex
CREATE INDEX "Communication_userId_idx" ON "Communication"("userId");

-- CreateIndex
CREATE INDEX "Communication_occurredAt_idx" ON "Communication"("occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "Call_communicationId_key" ON "Call"("communicationId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_communicationId_key" ON "Message"("communicationId");

-- CreateIndex
CREATE INDEX "Task_clientId_idx" ON "Task"("clientId");

-- CreateIndex
CREATE INDEX "Task_assigneeId_status_idx" ON "Task"("assigneeId", "status");

-- CreateIndex
CREATE INDEX "Task_dueAt_idx" ON "Task"("dueAt");

-- CreateIndex
CREATE INDEX "Note_clientId_idx" ON "Note"("clientId");

-- CreateIndex
CREATE INDEX "LeadSource_organizationId_idx" ON "LeadSource"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "LeadSource_organizationId_key_key" ON "LeadSource"("organizationId", "key");

-- CreateIndex
CREATE INDEX "Campaign_organizationId_idx" ON "Campaign"("organizationId");

-- CreateIndex
CREATE INDEX "AttributionEvent_clientId_idx" ON "AttributionEvent"("clientId");

-- CreateIndex
CREATE INDEX "AttributionEvent_campaignId_idx" ON "AttributionEvent"("campaignId");

-- CreateIndex
CREATE INDEX "AttributionEvent_occurredAt_idx" ON "AttributionEvent"("occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "Deal_clientId_key" ON "Deal"("clientId");

-- CreateIndex
CREATE INDEX "Submission_clientId_idx" ON "Submission"("clientId");

-- CreateIndex
CREATE INDEX "Submission_status_idx" ON "Submission"("status");

-- CreateIndex
CREATE INDEX "AIRecommendation_clientId_type_idx" ON "AIRecommendation"("clientId", "type");

-- CreateIndex
CREATE INDEX "Connector_organizationId_idx" ON "Connector"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Connector_organizationId_kind_key" ON "Connector"("organizationId", "kind");

-- CreateIndex
CREATE INDEX "ConnectorLog_connectorId_createdAt_idx" ON "ConnectorLog"("connectorId", "createdAt");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification"("userId", "readAt");

-- CreateIndex
CREATE INDEX "AuditEvent_organizationId_createdAt_idx" ON "AuditEvent"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_entityType_entityId_idx" ON "AuditEvent"("entityType", "entityId");

-- AddForeignKey
ALTER TABLE "Region" ADD CONSTRAINT "Region_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Team" ADD CONSTRAINT "Team_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Role" ADD CONSTRAINT "Role_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RolePermission" ADD CONSTRAINT "RolePermission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "Permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "Role"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_managerId_fkey" FOREIGN KEY ("managerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSession" ADD CONSTRAINT "UserSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pipeline" ADD CONSTRAINT "Pipeline_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PipelineStage" ADD CONSTRAINT "PipelineStage_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "Pipeline"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StageHistory" ADD CONSTRAINT "StageHistory_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StageHistory" ADD CONSTRAINT "StageHistory_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "PipelineStage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StageHistory" ADD CONSTRAINT "StageHistory_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "Pipeline"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_currentStageId_fkey" FOREIGN KEY ("currentStageId") REFERENCES "PipelineStage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_regionId_fkey" FOREIGN KEY ("regionId") REFERENCES "Region"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_portalUserId_fkey" FOREIGN KEY ("portalUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_leadSourceId_fkey" FOREIGN KEY ("leadSourceId") REFERENCES "LeadSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientAddress" ADD CONSTRAINT "ClientAddress_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Survey" ADD CONSTRAINT "Survey_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SurveyResponse" ADD CONSTRAINT "SurveyResponse_surveyId_fkey" FOREIGN KEY ("surveyId") REFERENCES "Survey"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SurveyResponse" ADD CONSTRAINT "SurveyResponse_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Consent" ADD CONSTRAINT "Consent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Verification" ADD CONSTRAINT "Verification_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditPull" ADD CONSTRAINT "CreditPull_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QualificationReview" ADD CONSTRAINT "QualificationReview_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QualificationReview" ADD CONSTRAINT "QualificationReview_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Assignment" ADD CONSTRAINT "Assignment_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AvailabilitySlot" ADD CONSTRAINT "AvailabilitySlot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Presentation" ADD CONSTRAINT "Presentation_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Presentation" ADD CONSTRAINT "Presentation_appointmentId_fkey" FOREIGN KEY ("appointmentId") REFERENCES "Appointment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Presentation" ADD CONSTRAINT "Presentation_presenterId_fkey" FOREIGN KEY ("presenterId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentMethod" ADD CONSTRAINT "PaymentMethod_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancingApplication" ADD CONSTRAINT "FinancingApplication_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentPackage" ADD CONSTRAINT "DocumentPackage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentRequirement" ADD CONSTRAINT "DocumentRequirement_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "DocumentPackage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientDocument" ADD CONSTRAINT "ClientDocument_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientDocument" ADD CONSTRAINT "ClientDocument_requirementId_fkey" FOREIGN KEY ("requirementId") REFERENCES "DocumentRequirement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientDocument" ADD CONSTRAINT "ClientDocument_collectorId_fkey" FOREIGN KEY ("collectorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentReview" ADD CONSTRAINT "DocumentReview_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "ClientDocument"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentReview" ADD CONSTRAINT "DocumentReview_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Communication" ADD CONSTRAINT "Communication_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Communication" ADD CONSTRAINT "Communication_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_communicationId_fkey" FOREIGN KEY ("communicationId") REFERENCES "Communication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_communicationId_fkey" FOREIGN KEY ("communicationId") REFERENCES "Communication"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadSource" ADD CONSTRAINT "LeadSource_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_leadSourceId_fkey" FOREIGN KEY ("leadSourceId") REFERENCES "LeadSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttributionEvent" ADD CONSTRAINT "AttributionEvent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttributionEvent" ADD CONSTRAINT "AttributionEvent_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttributionEvent" ADD CONSTRAINT "AttributionEvent_leadSourceId_fkey" FOREIGN KEY ("leadSourceId") REFERENCES "LeadSource"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Deal" ADD CONSTRAINT "Deal_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_dealId_fkey" FOREIGN KEY ("dealId") REFERENCES "Deal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIRecommendation" ADD CONSTRAINT "AIRecommendation_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AIRecommendation" ADD CONSTRAINT "AIRecommendation_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Connector" ADD CONSTRAINT "Connector_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectorLog" ADD CONSTRAINT "ConnectorLog_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "Connector"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
