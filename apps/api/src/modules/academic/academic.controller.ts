import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { Roles } from '../../core/auth/decorators';
import { AcademicService } from './academic.service';
import {
  createAcademicYearSchema,
  createClassroomSchema,
  createStudentSchema,
  createSubjectSchema,
  updateStudentSchema,
} from './academic.dto';

// Master data dikelola TU/Yayasan Admin (PRD Modul 2); read terbuka untuk
// role sekolah lain menyusul kalau dibutuhkan (guru lihat kelas dsb).
@Controller('academic')
@Roles('UNIT_ADMIN', 'YAYASAN_ADMIN')
export class AcademicController {
  constructor(private readonly academic: AcademicService) {}

  @Post('years')
  createYear(@Body() body: unknown) {
    return this.academic.createAcademicYear(createAcademicYearSchema.parse(body));
  }

  @Get('years')
  listYears() {
    return this.academic.listAcademicYears();
  }

  @Post('years/:id/activate')
  activateYear(@Param('id') id: string) {
    return this.academic.activateAcademicYear(id);
  }

  @Post('classrooms')
  createClassroom(@Body() body: unknown) {
    return this.academic.createClassroom(createClassroomSchema.parse(body));
  }

  @Get('classrooms')
  listClassrooms(@Query('academicYearId') academicYearId?: string) {
    return this.academic.listClassrooms(academicYearId);
  }

  @Post('subjects')
  createSubject(@Body() body: unknown) {
    return this.academic.createSubject(createSubjectSchema.parse(body));
  }

  @Get('subjects')
  listSubjects() {
    return this.academic.listSubjects();
  }

  @Post('students')
  createStudent(@Body() body: unknown) {
    return this.academic.createStudent(createStudentSchema.parse(body));
  }

  @Get('students')
  listStudents(@Query('classroomId') classroomId?: string) {
    return this.academic.listStudents(classroomId);
  }

  @Patch('students/:id')
  updateStudent(@Param('id') id: string, @Body() body: unknown) {
    return this.academic.updateStudent(id, updateStudentSchema.parse(body));
  }

  @Delete('students/:id')
  deleteStudent(@Param('id') id: string) {
    return this.academic.deleteStudent(id);
  }
}
