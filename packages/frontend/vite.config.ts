//-----------------------------------------------------------------------
// <copyright company="Microsoft Corporation">
//        Copyright (c) Microsoft Corporation.  All rights reserved.
//        Licensed under the MIT license. See LICENSE file in the project root for full license information.
// </copyright>
//-----------------------------------------------------------------------

import react from '@vitejs/plugin-react-swc';
import { rayfinLocalDev } from '@microsoft/rayfin-local-dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig, type PluginOption } from 'vite';
import license from 'rollup-plugin-license';

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { embeddedHostLicenseFromReadme } from './license-attribution.ts';

const projectRoot = process.env.PROJECT_ROOT || import.meta.dirname;
const require = createRequire(import.meta.url);

function embeddedHostLicense(version: string | null, declaredLicense: string | null): string {
  const packagePath = require.resolve('@microsoft/fabric-embedded-host/package.json');
  const metadata: unknown = JSON.parse(readFileSync(packagePath, 'utf8'));
  if (!metadata || typeof metadata !== 'object' ||
      !('name' in metadata) || metadata.name !== '@microsoft/fabric-embedded-host' ||
      !('version' in metadata) || metadata.version !== version ||
      !('license' in metadata) || metadata.license !== 'MIT' || declaredLicense !== 'MIT') {
    throw new Error('The embedded-host package attribution could not be verified.');
  }
  return embeddedHostLicenseFromReadme(readFileSync(resolve(dirname(packagePath), 'README.md'), 'utf8'));
}

// Dev-only middleware: makes the local Vite server compatible with browsers that
// enforce Local Network Access (LNA) checks when a public origin (the Fabric portal)
// embeds an iframe pointing at http://localhost. Sets the LNA opt-in response header
// on every response and short-circuits the corresponding preflight OPTIONS request.
// This is required for fetch/XHR subresources from the embedded app — top-level
// iframe navigations additionally require launching Chromium with the
// `--disable-features=...LocalNetworkAccessChecks` flag (a browser flag your test tooling must set).
const localNetworkAccessPlugin: PluginOption = {
  name: 'local-network-access-headers',
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      res.setHeader('Access-Control-Allow-Private-Network', 'true');
      if (
        req.method === 'OPTIONS' &&
        req.headers['access-control-request-private-network']
      ) {
        const origin = req.headers.origin || '*';
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
        res.setHeader(
          'Access-Control-Allow-Headers',
          req.headers['access-control-request-headers'] || '*'
        );
        res.statusCode = 204;
        res.end();
        return;
      }
      next();
    });
  },
};

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    rayfinLocalDev({ autoLogin: true, sourceActivity: true }),
    localNetworkAccessPlugin,
  ],
  resolve: {
    alias: {
      '@': resolve(projectRoot, 'src'),
    },
    // Capability packages are linked during monorepo development. Force their
    // React imports onto the app's instance so production builds cannot bundle
    // a second dispatcher and fail hooks at runtime.
    dedupe: ['react', 'react-dom'],
  },
  build: {
    commonjsOptions: {
      include: [/node_modules/],
    },
    rollupOptions: {
      plugins: [
        license({
          thirdParty: {
            multipleVersions: true,
            output: {
              file: resolve(projectRoot, 'dist', 'THIRD_PARTY_NOTICES.txt'),
              template(dependencies) {
                if (dependencies.length === 0) {
                  return 'No third-party dependencies.';
                }
                return (
                  'This file was auto-generated at build time.\n\n' +
                  dependencies
                    .map((dep) => {
                      const lines = [
                        `${dep.name}@${dep.version}`,
                        `License: ${dep.license || 'UNKNOWN'}`,
                      ];
                      if (dep.author) {
                        lines.push(
                          `Author: ${typeof dep.author === 'string' ? dep.author : dep.author.text()}`
                        );
                      }
                      if (dep.noticeText) {
                        lines.push('', 'NOTICE:', dep.noticeText.trim());
                      }
                      const licenseText = dep.licenseText?.trim() ||
                        (dep.name === '@microsoft/fabric-embedded-host'
                          ? embeddedHostLicense(dep.version, dep.license) : '');
                      if (!licenseText) throw new Error(`License text is unavailable for ${dep.name ?? 'an unknown dependency'}.`);
                      lines.push('', licenseText);
                      return lines.join('\n');
                    })
                    .join('\n\n' + '='.repeat(60) + '\n\n')
                );
              },
            },
          },
        }),
      ],
    },
  },
});
