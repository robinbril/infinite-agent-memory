import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';
import { chatgpt } from 'e2e/oauth/chatgpt';

// ChatGPT subscription only, no API keys. Sign in once: `npx e2e login openai`.
// Locally e2e reads ~/.config/e2e/oauth.json; in CI put the same JSON in the
// E2E_OAUTH_CREDENTIALS secret. List models with `npx e2e models`.
//
// Pick per environment: `E2E_MODEL=gpt-6-sol E2E_JUDGE=gpt-6-astra npx e2e run`.
export default {
  // Test files match tests/**/*.e2e.ts by default.
  targets: [
    {
      engine: web(),
      app: {
        url: process.env.E2E_BASE_URL ?? 'http://127.0.0.1:3000',
        command: { executable: 'npm', args: ['run', 'dev'], log: '.e2e/logs/app.log' },
      },
    },
  ],
  agents: {
    default: {
      // A fast model acts; a different ChatGPT model judges, as a second opinion.
      model: chatgpt(process.env.E2E_MODEL ?? 'gpt-6-luna'),
      judge: chatgpt(process.env.E2E_JUDGE ?? 'gpt-6-sol'),
    },
  },
} satisfies E2EConfig;
