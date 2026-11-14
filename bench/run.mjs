#!/usr/bin/env node
// 通用压测命令行：node bench/run.mjs --scenario v2/journey --vus 500 --duration 60 --think 1000,3000
import {parseArgs} from 'node:util';
import {writeFile} from 'node:fs/promises';
import {runPhase, printPhase, here} from './lib/engine.mjs';

const {values: a} = parseArgs({options: {
  scenario: {type: 'string'}, base: {type: 'string', default: 'http://127.0.0.1:8800'},
  vus: {type: 'string', default: '500'}, duration: {type: 'string', default: '30'},
  think: {type: 'string', default: '0,0'}, ramp: {type: 'string', default: '0'},
  mode: {type: 'string', default: 'loop'}, workers: {type: 'string', default: '3'},
  out: {type: 'string'}, params: {type: 'string', default: '{}'}, name: {type: 'string'}
}});
if (!a.scenario) { console.error('缺少 --scenario，例如 v2/journey'); process.exit(2); }
const report = await runPhase({
  name: a.name || a.scenario, scenario: here(import.meta, './scenarios/' + a.scenario + '.mjs'), base: a.base,
  vus: Number(a.vus), durationMs: Number(a.duration) * 1000, think: a.think.split(',').map(Number),
  rampMs: Number(a.ramp) * 1000, mode: a.mode, workers: Number(a.workers), params: JSON.parse(a.params)
});
printPhase(report);
if (a.out) await writeFile(a.out, JSON.stringify({date: new Date().toISOString(), base: a.base, ...report}, null, 2) + '\n');
