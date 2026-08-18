import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";

export interface SettingsAccountCardProps {
  userName: string;
  onLogout: () => void;
}

/**
 * The Settings screen's "who is signed in, and a way to sign out" panel.
 * Props only — no `useSession` of its own, so it renders standalone from
 * just `userName` and `onLogout`. Kept separate from `SettingsConfigCard`
 * (rather than one combined component) so `routes/settings.tsx` can let the
 * configuration panel fail independently — the same per-panel error
 * convention `routes/index.tsx` uses — without also hiding the account info
 * and logout control, which have nothing to do with whether `/api/settings`
 * resolved.
 */
export function SettingsAccountCard({ userName, onLogout }: SettingsAccountCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Account</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div>
          <p className="text-sm text-muted-foreground">Signed in as</p>
          <p className="text-base font-medium text-foreground">{userName}</p>
        </div>
        <div>
          <Button variant="outline" size="sm" onClick={onLogout}>
            Log out
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
