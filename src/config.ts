import fs from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';
import { Config } from './types.js';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

export function loadConfig(): Config {
  const configPath = path.join(PROJECT_ROOT, 'config.yaml');
  if (!fs.existsSync(configPath)) {
    throw new Error(`Config file not found: ${configPath}`);
  }
  const raw = fs.readFileSync(configPath, 'utf8');
  const config = parseYaml(raw) as Config;

  // Validate required fields
  if (!config.lists?.length) throw new Error('config.yaml: at least one list required');
  for (const list of config.lists) {
    if (!list.id) throw new Error('config.yaml: each list needs an id');
    if (!list.name) throw new Error('config.yaml: each list needs a name');
  }
  if (!config.digest) throw new Error('config.yaml: digest section required');
  if (!config.consensus) throw new Error('config.yaml: consensus section required');

  return config;
}

// Re-read .env on every call (hot-reload cookies)
export function loadEnv(): Record<string, string> {
  const envPath = path.join(PROJECT_ROOT, '.env');
  if (!fs.existsSync(envPath)) {
    throw new Error(`.env file not found: ${envPath}`);
  }
  const env: Record<string, string> = {};
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return env;
}

export function getRequiredEnv(env: Record<string, string>, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`Missing required env var: ${key}`);
  return value;
}
