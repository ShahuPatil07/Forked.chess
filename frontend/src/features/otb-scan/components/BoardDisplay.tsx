import { Chessboard } from 'react-chessboard'

interface Props {
  fen: string
  boardWidth?: number
  orientation?: 'white' | 'black'
  onSquareClick?: (square: string) => void
  customSquareStyles?: Record<string, React.CSSProperties>
}

// react-chessboard wrapper themed to match the Forked board styling.
export function BoardDisplay({
  fen,
  boardWidth,
  orientation = 'white',
  onSquareClick,
  customSquareStyles,
}: Props) {
  return (
    <Chessboard
      position={fen}
      boardWidth={boardWidth}
      boardOrientation={orientation}
      arePiecesDraggable={false}
      onSquareClick={onSquareClick}
      customSquareStyles={customSquareStyles}
      customBoardStyle={{
        borderRadius: '8px',
        boxShadow: '0 4px 24px rgba(0,0,0,0.4)',
      }}
      customDarkSquareStyle={{ backgroundColor: '#3a3a52' }}
      customLightSquareStyle={{ backgroundColor: '#b8b8d0' }}
    />
  )
}
