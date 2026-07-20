import type { FeatureSnapshot } from '../types/feature.ts';

export class FeatureStore {
  private snapshots: Map<string, FeatureSnapshot> = new Map();

  set(snapshot: FeatureSnapshot): void {
    this.snapshots.set(snapshot.mint, snapshot);
  }

  get(mint: string): FeatureSnapshot | undefined {
    return this.snapshots.get(mint);
  }

  getAll(): FeatureSnapshot[] {
    return Array.from(this.snapshots.values());
  }

  clear(): void {
    this.snapshots.clear();
  }
}
