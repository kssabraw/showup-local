import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

const LoginView = ({ onAuth }: { onAuth: () => void }) => {
  const [mode, setMode] = useState<"signin" | "signup" | "reset">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const switchMode = (next: typeof mode) => {
    setMode(next);
    setError("");
    setMessage("");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setMessage("");
    setLoading(true);

    try {
      if (mode === "signup") {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        setMessage("Check your email to confirm your account, then sign in.");
        switchMode("signin");
      } else if (mode === "reset") {
        const { error } = await supabase.auth.resetPasswordForEmail(email, {
          redirectTo: `${window.location.origin}/?reset=1`,
        });
        if (error) throw error;
        setMessage("Password reset email sent — check your inbox.");
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
        onAuth();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center">
          <h1 className="text-2xl font-display font-bold text-foreground">ShowUP Local</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {mode === "signin" ? "Sign in to your account"
              : mode === "signup" ? "Create an account"
              : "Reset your password"}
          </p>
        </div>

        <div className="bg-card rounded-xl border border-border p-6 space-y-4">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">Email</label>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                required
                autoComplete="email"
              />
            </div>

            {mode !== "reset" && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium text-foreground">Password</label>
                  {mode === "signin" && (
                    <button
                      type="button"
                      onClick={() => switchMode("reset")}
                      className="text-xs text-muted-foreground hover:text-accent transition-colors"
                    >
                      Forgot password?
                    </button>
                  )}
                </div>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  required
                  autoComplete={mode === "signup" ? "new-password" : "current-password"}
                  minLength={6}
                />
              </div>
            )}

            {error && <p className="text-sm text-destructive">{error}</p>}
            {message && <p className="text-sm text-green-600 dark:text-green-400">{message}</p>}

            <Button type="submit" className="w-full" disabled={loading}>
              {loading && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
              {mode === "signin" ? "Sign In"
                : mode === "signup" ? "Create Account"
                : "Send Reset Email"}
            </Button>
          </form>

          <div className="text-center text-sm text-muted-foreground">
            {mode === "signin" ? (
              <>
                Don't have an account?{" "}
                <button onClick={() => switchMode("signup")} className="text-accent hover:underline">
                  Sign up
                </button>
              </>
            ) : mode === "signup" ? (
              <>
                Already have an account?{" "}
                <button onClick={() => switchMode("signin")} className="text-accent hover:underline">
                  Sign in
                </button>
              </>
            ) : (
              <>
                Remembered it?{" "}
                <button onClick={() => switchMode("signin")} className="text-accent hover:underline">
                  Back to sign in
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default LoginView;

