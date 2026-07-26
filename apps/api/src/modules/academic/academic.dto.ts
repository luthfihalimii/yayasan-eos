import { z } from 'zod';

export const createAcademicYearSchema = z.object({
  label: z.string().regex(/^\d{4}\/\d{4}$/, 'Format: 2026/2027'),
  startsOn: z.coerce.date(),
  endsOn: z.coerce.date(),
});

export const createClassroomSchema = z.object({
  academicYearId: z.string().uuid(),
  grade: z.number().int().min(1).max(12),
  name: z.string().min(1).max(32),
});

export const createSubjectSchema = z.object({
  code: z.string().min(1).max(16).toUpperCase(),
  name: z.string().min(1).max(128),
});

export const createStudentSchema = z.object({
  nis: z.string().min(1).max(32),
  fullName: z.string().min(1).max(256),
  classroomId: z.string().uuid().optional(),
});

export type CreateAcademicYear = z.infer<typeof createAcademicYearSchema>;
export type CreateClassroom = z.infer<typeof createClassroomSchema>;
export type CreateSubject = z.infer<typeof createSubjectSchema>;
export type CreateStudent = z.infer<typeof createStudentSchema>;
