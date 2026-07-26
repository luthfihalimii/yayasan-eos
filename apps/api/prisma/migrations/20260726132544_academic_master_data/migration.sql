-- DropForeignKey
ALTER TABLE "JournalEntry" DROP CONSTRAINT "JournalEntry_reversalOfJournalId_fkey";

-- CreateTable
CREATE TABLE "AcademicYear" (
    "id" UUID NOT NULL,
    "unitId" UUID NOT NULL,
    "label" TEXT NOT NULL,
    "startsOn" DATE NOT NULL,
    "endsOn" DATE NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AcademicYear_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Classroom" (
    "id" UUID NOT NULL,
    "unitId" UUID NOT NULL,
    "academicYearId" UUID NOT NULL,
    "grade" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Classroom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subject" (
    "id" UUID NOT NULL,
    "unitId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Subject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Student" (
    "id" UUID NOT NULL,
    "unitId" UUID NOT NULL,
    "classroomId" UUID,
    "nis" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "userId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Student_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AcademicYear_unitId_isActive_idx" ON "AcademicYear"("unitId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "AcademicYear_unitId_label_key" ON "AcademicYear"("unitId", "label");

-- CreateIndex
CREATE INDEX "Classroom_unitId_grade_idx" ON "Classroom"("unitId", "grade");

-- CreateIndex
CREATE UNIQUE INDEX "Classroom_unitId_academicYearId_name_key" ON "Classroom"("unitId", "academicYearId", "name");

-- CreateIndex
CREATE INDEX "Subject_unitId_idx" ON "Subject"("unitId");

-- CreateIndex
CREATE UNIQUE INDEX "Subject_unitId_code_key" ON "Subject"("unitId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "Student_userId_key" ON "Student"("userId");

-- CreateIndex
CREATE INDEX "Student_unitId_classroomId_idx" ON "Student"("unitId", "classroomId");

-- CreateIndex
CREATE UNIQUE INDEX "Student_unitId_nis_key" ON "Student"("unitId", "nis");

-- AddForeignKey
ALTER TABLE "Classroom" ADD CONSTRAINT "Classroom_academicYearId_fkey" FOREIGN KEY ("academicYearId") REFERENCES "AcademicYear"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Student" ADD CONSTRAINT "Student_classroomId_fkey" FOREIGN KEY ("classroomId") REFERENCES "Classroom"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_reversalOfJournalId_fkey" FOREIGN KEY ("reversalOfJournalId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ============================================================
-- HAND-EDITED (AGENTS.md §4.2): RLS fail-closed untuk master data akademik.
-- Pola sama dengan init: GUC unset/'' = DENY, cross-unit = '__ALL__'.
-- ============================================================
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['AcademicYear','Classroom','Subject','Student'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY unit_isolation ON %I USING ' ||
      '("unitId"::text = current_setting(''app.current_unit_id'', true) ' ||
      'OR current_setting(''app.current_unit_id'', true) = ''__ALL__'')', t);
  END LOOP;
END $$;
