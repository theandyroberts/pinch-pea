import { PALETTE_ORDER, byKey } from "./blocks.js";
import { CFG } from "./config.js";

export class Inventory {
  constructor() {
    this.counts = {};
    for (const k of PALETTE_ORDER) this.counts[k] = 0;
    for (const [k, n] of Object.entries(CFG.startInventory)) this.counts[k] = n;
    this.counts.sapling = 3;
    this.counts.flower = 5;   // matches the flower-garden quest goal exactly
    this.selected = "cream";
    this.onChange = null;
  }
  has(key) { return (this.counts[key] | 0) > 0; }
  add(key, n = 1) {
    if (!(key in this.counts)) return false;
    const before = this.counts[key];
    this.counts[key] = Math.min(CFG.stackMax, before + n);
    this.onChange && this.onChange();
    return this.counts[key] !== before;
  }
  consume(key, n = 1) {
    if ((this.counts[key] | 0) < n) return false;
    this.counts[key] -= n;
    this.onChange && this.onChange();
    return true;
  }
  select(key) {
    if (key in this.counts) { this.selected = key; this.onChange && this.onChange(); }
  }
  blockIdFor(key) { return byKey[key]?.id ?? 0; }
  serialize() { return { counts: { ...this.counts }, selected: this.selected }; }
  load(d) {
    if (!d) return;
    Object.assign(this.counts, d.counts || {});
    if (d.selected in this.counts) this.selected = d.selected;
    this.onChange && this.onChange();
  }
}
