
export interface SphereData {
  id: string;
  position: [number, number, number];
  color: string;
  scale: number;
}

export interface MatrixConfig {
  rows: number;
  cols: number;
  layers: number;
  spacing: number;
}
