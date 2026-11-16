import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { parse } from "./parse.js";
const raw = readFileSync("/input/cases.json", "utf8");
const cases = JSON.parse(raw);
const out = new Array(cases.length);
for (let k = 0; k < cases.length; k++) out[k] = parse(cases[k].markdown);
mkdirSync("/output", { recursive: true });
writeFileSync("/output/html.json", JSON.stringify(out));

// Batch harness: reads every case, renders each with parse, writes one HTML string per case in input order.
