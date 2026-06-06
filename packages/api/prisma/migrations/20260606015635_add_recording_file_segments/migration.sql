-- AlterTable
ALTER TABLE "recording_files" ADD COLUMN     "segments" JSONB NOT NULL DEFAULT '[]';
