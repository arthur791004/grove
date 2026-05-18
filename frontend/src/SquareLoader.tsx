import { Box } from '@chakra-ui/react';

interface Props {
  size?: number;
  ariaLabel?: string;
}

export function SquareLoader({ size = 4, ariaLabel }: Props) {
  const px = `${size}px`;
  return (
    <Box
      className="grove-sq-loader"
      aria-label={ariaLabel}
      style={{
        gridTemplateColumns: `${px} ${px}`,
        gridTemplateRows: `${px} ${px}`,
        gap: size * 0.375,
      }}
    >
      <span />
      <span />
      <span />
      <span />
    </Box>
  );
}
