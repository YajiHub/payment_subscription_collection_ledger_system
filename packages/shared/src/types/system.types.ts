// The shape of a system setting as it travels over the API.

export interface SystemSetting {
  key: string;
  value: string;
  description: string;
  updatedAt: string;
  updatedBy: string | null;
}
