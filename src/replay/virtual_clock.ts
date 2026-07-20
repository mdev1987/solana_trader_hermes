export class VirtualClock {
  private currentTime: number;
  private speed: number;

  constructor(startTime: number, speed = 1) {
    this.currentTime = startTime;
    this.speed = speed;
  }

  get time(): number {
    return this.currentTime;
  }

  setSpeed(speed: number): void {
    this.speed = speed;
  }

  advance(realMs: number): void {
    this.currentTime += realMs * this.speed;
  }

  setTime(ts: number): void {
    this.currentTime = ts;
  }
}
