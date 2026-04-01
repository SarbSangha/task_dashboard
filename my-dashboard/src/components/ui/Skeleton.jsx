export function SkeletonBlock({
  width = '100%',
  height = 16,
  rounded = false,
  className = '',
  style,
}) {
  return (
    <div
      aria-hidden="true"
      className={`skeleton-block${className ? ` ${className}` : ''}`}
      style={{
        width,
        height,
        borderRadius: rounded ? 9999 : 6,
        ...style,
      }}
    />
  );
}
