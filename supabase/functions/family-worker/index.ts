// Перед развёртыванием: node tools/build-family-function.mjs
import { createFamilyWorker } from '../_shared/finance/core/family-worker.js';

Deno.serve(createFamilyWorker({ env: (name: string) => Deno.env.get(name) }));
