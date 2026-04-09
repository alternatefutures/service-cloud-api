-- CreateEnum
CREATE TYPE "FeedbackCategory" AS ENUM ('BUG', 'FEEDBACK', 'FEATURE_REQUEST');

-- CreateTable
CREATE TABLE "feedback_report" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "category" "FeedbackCategory" NOT NULL,
    "location" TEXT,
    "description" TEXT NOT NULL,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_report_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "feedback_report_user_id_idx" ON "feedback_report"("user_id");

-- CreateIndex
CREATE INDEX "feedback_report_category_idx" ON "feedback_report"("category");

-- CreateIndex
CREATE INDEX "feedback_report_created_at_idx" ON "feedback_report"("created_at");

-- AddForeignKey
ALTER TABLE "feedback_report" ADD CONSTRAINT "feedback_report_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
