import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../main.dart';

const allowedDomain = '@trigunabhakti.or.id';

class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _formKey = GlobalKey<FormState>();
  final _email = TextEditingController();
  final _password = TextEditingController();
  final _totp = TextEditingController();
  bool _loading = false;
  bool _mfaStep = false;
  String? _error;

  Future<void> _submit() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    final api = ref.read(apiClientProvider);
    try {
      final res = await api.post('/auth/login', {
        'email': _email.text.trim().toLowerCase(),
        'password': _password.text,
        if (_mfaStep && _totp.text.isNotEmpty) 'totpCode': _totp.text,
      });
      await api.saveToken(res['accessToken'] as String);
      if (mounted) {
        // ponytail: sementara ke placeholder home; router (go_router) menyusul
        // bersama layar siswa/orang tua Phase 3-4.
        Navigator.of(context).pushReplacement(
          MaterialPageRoute<void>(builder: (_) => const _HomePlaceholder()),
        );
      }
    } on ApiException catch (e) {
      setState(() {
        if (e.mfaRequired) {
          _mfaStep = true;
          _error = _totp.text.isEmpty ? null : 'Kode autentikator salah.';
        } else if (e.status == 429) {
          _error = 'Terlalu banyak percobaan. Tunggu satu menit.';
        } else {
          _error = e.status == 401 ? 'Email atau password salah.' : e.message;
        }
      });
    } catch (_) {
      setState(() => _error = 'Tidak bisa terhubung ke server.');
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Form(
                key: _formKey,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Container(
                      width: 64,
                      height: 64,
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        color: Theme.of(context).colorScheme.primary,
                        borderRadius: BorderRadius.circular(16),
                      ),
                      child: const Text(
                        'TB',
                        style: TextStyle(color: Colors.white, fontSize: 24, fontWeight: FontWeight.bold),
                      ),
                    ),
                    const SizedBox(height: 24),
                    Text(
                      _mfaStep ? 'Verifikasi dua langkah' : 'Yayasan EOS',
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.w700),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      _mfaStep
                          ? 'Masukkan 6 digit kode dari aplikasi autentikator.'
                          : 'Masuk dengan akun @trigunabhakti.or.id',
                      textAlign: TextAlign.center,
                      style: Theme.of(context).textTheme.bodyMedium?.copyWith(color: Colors.grey.shade600),
                    ),
                    const SizedBox(height: 32),
                    if (_error != null) ...[
                      Container(
                        padding: const EdgeInsets.all(12),
                        decoration: BoxDecoration(
                          color: const Color(0xFFFEF2F2),
                          borderRadius: BorderRadius.circular(12),
                          border: Border.all(color: const Color(0xFFFECACA)),
                        ),
                        child: Text(_error!, style: const TextStyle(color: Color(0xFF991B1B))),
                      ),
                      const SizedBox(height: 16),
                    ],
                    if (!_mfaStep) ...[
                      TextFormField(
                        controller: _email,
                        keyboardType: TextInputType.emailAddress,
                        autofillHints: const [AutofillHints.email],
                        decoration: const InputDecoration(labelText: 'Email'),
                        validator: (v) {
                          final email = (v ?? '').trim().toLowerCase();
                          if (email.isEmpty) return 'Email wajib diisi';
                          if (!email.endsWith(allowedDomain)) {
                            return 'Email wajib domain $allowedDomain';
                          }
                          return null;
                        },
                      ),
                      const SizedBox(height: 16),
                      TextFormField(
                        controller: _password,
                        obscureText: true,
                        autofillHints: const [AutofillHints.password],
                        decoration: const InputDecoration(labelText: 'Password'),
                        validator: (v) => (v ?? '').isEmpty ? 'Password wajib diisi' : null,
                      ),
                    ] else
                      TextFormField(
                        controller: _totp,
                        keyboardType: TextInputType.number,
                        maxLength: 6,
                        autofillHints: const [AutofillHints.oneTimeCode],
                        textAlign: TextAlign.center,
                        style: const TextStyle(fontSize: 24, letterSpacing: 12, fontWeight: FontWeight.w600),
                        decoration: const InputDecoration(labelText: 'Kode Autentikator', counterText: ''),
                        validator: (v) => (v ?? '').length != 6 ? 'Masukkan 6 digit' : null,
                      ),
                    const SizedBox(height: 24),
                    FilledButton(
                      onPressed: _loading ? null : _submit,
                      child: _loading
                          ? const SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                          : Text(_mfaStep ? 'Verifikasi' : 'Masuk'),
                    ),
                    if (_mfaStep)
                      TextButton(
                        onPressed: () => setState(() {
                          _mfaStep = false;
                          _error = null;
                          _totp.clear();
                        }),
                        child: const Text('← Kembali'),
                      ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _HomePlaceholder extends StatelessWidget {
  const _HomePlaceholder();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Yayasan EOS')),
      body: const Center(child: Text('Login berhasil — fitur siswa/orang tua menyusul (Phase 3-4).')),
    );
  }
}
