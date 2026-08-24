export const colors = {
  moss: "#D94F67",
  mossDeep: "#A82F49",
  olive: "#332028",
  oliveSoft: "#5D4650",
  cream: "#FFF0EA",
  ink: "#332028",
  paper: "#FFF9F6",
  surface: "#FFFFFF",
  muted: "#76616A",
  subtle: "#9B808A",
  placeholder: "#B69AA4",
  line: "#DFCEC9",
  faint: "#F5E9E5",
  error: "#B9364E",
} as const;

export const spacing = {
  xxs: 4,
  xs: 8,
  sm: 12,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;

export const radii = {
  sm: 10,
  md: 14,
  lg: 18,
  xl: 24,
  pill: 999,
} as const;

export const layout = {
  screenPadding: spacing.lg,
  headerHeight: 64,
  controlHeight: 62,
} as const;

export const fonts = {
  regular: "Pretendard-Regular",
  medium: "Pretendard-Medium",
  semibold: "Pretendard-SemiBold",
  bold: "Pretendard-Bold",
} as const;
