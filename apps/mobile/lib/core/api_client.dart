import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

/// Klien API EOS. Token JWT di secure storage (Keystore/Keychain),
/// bukan SharedPreferences — data anak, standar PRD §5.1.
class ApiClient {
  ApiClient({required this.baseUrl});

  final String baseUrl;
  static const _storage = FlutterSecureStorage();
  static const _tokenKey = 'eos_token';

  Future<String?> get token => _storage.read(key: _tokenKey);

  Future<void> saveToken(String value) => _storage.write(key: _tokenKey, value: value);

  Future<void> clearToken() => _storage.delete(key: _tokenKey);

  Future<Map<String, dynamic>> post(
    String path,
    Map<String, dynamic> body, {
    bool auth = false,
    String? activeUnitId,
  }) async {
    final res = await http.post(
      Uri.parse('$baseUrl$path'),
      headers: await _headers(auth: auth, activeUnitId: activeUnitId),
      body: jsonEncode(body),
    );
    return _decode(res);
  }

  Future<Map<String, dynamic>> get_(
    String path, {
    String? activeUnitId,
  }) async {
    final res = await http.get(
      Uri.parse('$baseUrl$path'),
      headers: await _headers(auth: true, activeUnitId: activeUnitId),
    );
    return _decode(res);
  }

  Future<Map<String, String>> _headers({required bool auth, String? activeUnitId}) async {
    final t = auth ? await token : null;
    return {
      'content-type': 'application/json',
      if (t != null) 'authorization': 'Bearer $t',
      'x-active-unit': ?activeUnitId,
    };
  }

  Map<String, dynamic> _decode(http.Response res) {
    final body = res.body.isEmpty ? <String, dynamic>{} : jsonDecode(res.body) as Map<String, dynamic>;
    if (res.statusCode >= 400) {
      throw ApiException(res.statusCode, body);
    }
    return body;
  }
}

class ApiException implements Exception {
  ApiException(this.status, this.body);

  final int status;
  final Map<String, dynamic> body;

  bool get mfaRequired => body['mfaRequired'] == true;

  String get message => (body['message'] as String?) ?? 'Terjadi kesalahan ($status)';
}
