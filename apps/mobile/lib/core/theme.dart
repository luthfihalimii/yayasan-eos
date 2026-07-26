import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

/// Tema merah-putih Triguna Bhakti + Poppins — konsisten dengan web admin.
class EosTheme {
  static const brand = Color(0xFFDC2626); // brand-500 web
  static const brandDark = Color(0xFF991B1B); // brand-700

  static ThemeData light() {
    final base = ThemeData(
      useMaterial3: true,
      colorScheme: ColorScheme.fromSeed(seedColor: brand, primary: brand),
      scaffoldBackgroundColor: const Color(0xFFF5F5F5),
    );
    return base.copyWith(
      textTheme: GoogleFonts.poppinsTextTheme(base.textTheme),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: brand,
          foregroundColor: Colors.white,
          minimumSize: const Size.fromHeight(52),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(26)),
          textStyle: GoogleFonts.poppins(fontWeight: FontWeight.w600),
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: Colors.white,
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: Color(0xFFD4D4D4)),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12),
          borderSide: const BorderSide(color: brand, width: 2),
        ),
      ),
    );
  }
}
