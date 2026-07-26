import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../core/prisma.service';
import { withUnitTx } from '../../core/prisma';
import { currentUnitContext, MissingUnitContextError } from '../../core/unit-context';
import { CreateAcademicYear, CreateClassroom, CreateStudent, CreateSubject, UpdateStudent } from './academic.dto';

/**
 * Semua akses lewat withUnitTx: RLS + Client-side scoping dari unit context
 * yang sudah divalidasi guard. unitId di data injeksi dari context — request
 * body TIDAK boleh membawa unitId sendiri (§4.1 caveat create).
 */
@Injectable()
export class AcademicService {
  constructor(private readonly prisma: PrismaService) {}

  private activeUnit(): string {
    const unitId = currentUnitContext.getStore();
    if (unitId === undefined || unitId === null) {
      // null (cross-unit) pun ditolak: master data selalu per-unit.
      throw new MissingUnitContextError();
    }
    return unitId;
  }

  // --- AcademicYear ---
  createAcademicYear(dto: CreateAcademicYear) {
    const unitId = this.activeUnit();
    return withUnitTx(this.prisma, (tx) =>
      tx.academicYear.create({ data: { ...dto, unitId } }),
    );
  }

  listAcademicYears() {
    this.activeUnit();
    return withUnitTx(this.prisma, (tx) =>
      tx.academicYear.findMany({ orderBy: { startsOn: 'desc' } }),
    );
  }

  /** Satu tahun ajaran aktif per unit — atomik dalam satu transaksi. */
  activateAcademicYear(id: string) {
    this.activeUnit();
    return withUnitTx(this.prisma, async (tx) => {
      await tx.academicYear.updateMany({ data: { isActive: false } }); // scoped RLS = hanya unit ini
      return tx.academicYear.update({ where: { id }, data: { isActive: true } });
    });
  }

  // --- Classroom ---
  createClassroom(dto: CreateClassroom) {
    const unitId = this.activeUnit();
    return withUnitTx(this.prisma, async (tx) => {
      // RLS menyaring tahun ajaran unit lain → findUniqueOrThrow gagal = 404 wajar.
      await tx.academicYear.findUniqueOrThrow({ where: { id: dto.academicYearId } });
      return tx.classroom.create({ data: { ...dto, unitId } });
    });
  }

  listClassrooms(academicYearId?: string) {
    this.activeUnit();
    return withUnitTx(this.prisma, (tx) =>
      tx.classroom.findMany({
        where: academicYearId ? { academicYearId } : undefined,
        orderBy: [{ grade: 'asc' }, { name: 'asc' }],
      }),
    );
  }

  // --- Subject ---
  createSubject(dto: CreateSubject) {
    const unitId = this.activeUnit();
    return withUnitTx(this.prisma, (tx) => tx.subject.create({ data: { ...dto, unitId } }));
  }

  listSubjects() {
    this.activeUnit();
    return withUnitTx(this.prisma, (tx) => tx.subject.findMany({ orderBy: { code: 'asc' } }));
  }

  // --- Student ---
  createStudent(dto: CreateStudent) {
    const unitId = this.activeUnit();
    return withUnitTx(this.prisma, (tx) => tx.student.create({ data: { ...dto, unitId } }));
  }

  listStudents(classroomId?: string) {
    this.activeUnit();
    return withUnitTx(this.prisma, (tx) =>
      tx.student.findMany({
        where: classroomId ? { classroomId } : undefined,
        orderBy: { fullName: 'asc' },
      }),
    );
  }

  updateStudent(id: string, dto: UpdateStudent) {
    this.activeUnit();
    return withUnitTx(this.prisma, (tx) =>
      // RLS: baris unit lain tak terlihat → P2025 → 404 dari exception filter.
      tx.student.update({ where: { id }, data: dto }),
    );
  }

  deleteStudent(id: string) {
    this.activeUnit();
    return withUnitTx(this.prisma, (tx) => tx.student.delete({ where: { id } }));
  }
}
