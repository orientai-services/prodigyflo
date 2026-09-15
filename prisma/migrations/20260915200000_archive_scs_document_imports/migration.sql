-- Historical SCS test-import provenance is retained but can be made terminal
-- without pretending that it was a failed retry or deleting a client file.
ALTER TYPE "ExternalDocumentImportStatus" ADD VALUE IF NOT EXISTS 'ARCHIVED';
