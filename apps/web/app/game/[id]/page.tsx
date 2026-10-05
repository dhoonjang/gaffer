import { GameScreen } from "@/game/game-screen";

export default async function GamePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <GameScreen gameId={id} />;
}
