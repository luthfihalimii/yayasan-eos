import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'core/api_client.dart';
import 'core/theme.dart';
import 'features/auth/login_screen.dart';

// API base URL — --dart-define=API_URL=https://api.trigunabhakti.or.id di build produksi.
// 10.0.2.2 = host loopback dari emulator Android.
const _apiUrl = String.fromEnvironment('API_URL', defaultValue: 'http://10.0.2.2:3000');

final apiClientProvider = Provider<ApiClient>((ref) => ApiClient(baseUrl: _apiUrl));

void main() {
  runApp(const ProviderScope(child: EosApp()));
}

class EosApp extends StatelessWidget {
  const EosApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Yayasan EOS',
      theme: EosTheme.light(),
      debugShowCheckedModeBanner: false,
      home: const LoginScreen(),
    );
  }
}
