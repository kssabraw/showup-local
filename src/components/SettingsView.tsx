import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2, Lock, Users, CreditCard, X, Mail } from "lucide-react";
import type { Session } from "@supabase/supabase-js";

const MAX_TEAM_MEMBERS = 2;

interface TeamMember {
  id: string;
  email: string;
  name: string;
  created_at: string;
}

function Initials({ name, email }: { name: string; email: string }) {
  const src = name.trim() || email;
  const parts = src.trim().split(/\s+/);
  const letters = parts.length >= 2
    ? parts[0][0] + parts[parts.length - 1][0]
    : src.slice(0, 2);
  return (
    <div className="w-8 h-8 rounded-full bg-accent/20 text-accent flex items-center justify-center text-xs font-semibold uppercase shrink-0">
      {letters}
    </div>
  );
}

function Section({ icon: Icon, title, description, children }: {
  icon: React.ElementType;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="px-6 py-5 border-b border-border">
        <div className="flex items-center gap-2">
          <Icon className="w-4 h-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
        </div>
        {description && (
          <p className="text-xs text-muted-foreground mt-1">{description}</p>
        )}
      </div>
      <div className="px-6 py-5">{children}</div>
    </div>
  );
}

export default function SettingsView({ session }: { session: Session }) {
  const { toast } = useToast();

  // ── Password ─────────────────────────────────────────────────────────────
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);

  const handlePasswordChange = async () => {
    if (newPassword.length < 8) {
      toast({ title: "New password must be at least 8 characters", variant: "destructive" });
      return;
    }
    if (newPassword !== confirmPassword) {
      toast({ title: "New passwords don't match", variant: "destructive" });
      return;
    }
    setSavingPassword(true);
    // Re-authenticate with current password before allowing the change
    const { error: authError } = await supabase.auth.signInWithPassword({
      email: session.user.email!,
      password: currentPassword,
    });
    if (authError) {
      setSavingPassword(false);
      toast({ title: "Current password is incorrect", variant: "destructive" });
      return;
    }
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    setSavingPassword(false);
    if (error) {
      toast({ title: "Failed to update password", description: error.message, variant: "destructive" });
    } else {
      toast({ title: "Password updated" });
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    }
  };

  // ── Team members ─────────────────────────────────────────────────────────
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [loadingTeam, setLoadingTeam] = useState(true);
  const [inviteName, setInviteName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [addingMember, setAddingMember] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from("team_members")
      .select("id, email, name, created_at")
      .eq("owner_user_id", session.user.id)
      .order("created_at")
      .then(({ data }) => {
        setTeamMembers((data as TeamMember[]) ?? []);
        setLoadingTeam(false);
      });
  }, []);

  const handleAddMember = async () => {
    const email = inviteEmail.trim().toLowerCase();
    const name = inviteName.trim();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      toast({ title: "Please enter a valid email address", variant: "destructive" });
      return;
    }
    if (email === session.user.email?.toLowerCase()) {
      toast({ title: "That's your own email address", variant: "destructive" });
      return;
    }
    if (teamMembers.some(m => m.email.toLowerCase() === email)) {
      toast({ title: "That person is already on your team", variant: "destructive" });
      return;
    }
    setAddingMember(true);
    const { data, error } = await supabase
      .from("team_members")
      .insert({ owner_user_id: session.user.id, email, name })
      .select("id, email, name, created_at")
      .single();
    setAddingMember(false);
    if (error) {
      toast({ title: "Failed to add team member", description: error.message, variant: "destructive" });
    } else if (data) {
      setTeamMembers(prev => [...prev, data as TeamMember]);
      setInviteName("");
      setInviteEmail("");
      toast({ title: `${name || email} added to your team` });
    }
  };

  const handleRemoveMember = async (id: string) => {
    setRemovingId(id);
    const { error } = await supabase
      .from("team_members")
      .delete()
      .eq("id", id);
    setRemovingId(null);
    if (error) {
      toast({ title: "Failed to remove member", variant: "destructive" });
    } else {
      setTeamMembers(prev => prev.filter(m => m.id !== id));
    }
  };

  const slotsLeft = MAX_TEAM_MEMBERS - teamMembers.length;
  const canAdd = slotsLeft > 0;

  // ── Billing ──────────────────────────────────────────────────────────────
  const [pageCount, setPageCount] = useState<number | null>(null);

  useEffect(() => {
    supabase
      .from("generated_pages")
      .select("*", { count: "exact", head: true })
      .then(({ count }) => setPageCount(count ?? 0));
  }, []);

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-display font-bold text-foreground">Settings</h1>
        <p className="text-muted-foreground text-sm mt-1">Manage your account and workspace.</p>
      </div>

      {/* ── Change password ── */}
      <Section
        icon={Lock}
        title="Change Password"
        description={`Signed in as ${session.user.email}`}
      >
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Current password</Label>
            <Input
              type="password"
              value={currentPassword}
              onChange={e => setCurrentPassword(e.target.value)}
              placeholder="Your current password"
              autoComplete="current-password"
            />
          </div>
          <div className="space-y-1.5">
            <Label>New password</Label>
            <Input
              type="password"
              value={newPassword}
              onChange={e => setNewPassword(e.target.value)}
              placeholder="At least 8 characters"
              autoComplete="new-password"
            />
          </div>
          <div className="space-y-1.5">
            <Label>Confirm new password</Label>
            <Input
              type="password"
              value={confirmPassword}
              onChange={e => setConfirmPassword(e.target.value)}
              placeholder="Repeat new password"
              autoComplete="new-password"
              onKeyDown={e => { if (e.key === "Enter") handlePasswordChange(); }}
            />
          </div>
          <Button
            onClick={handlePasswordChange}
            disabled={savingPassword || !currentPassword || !newPassword || !confirmPassword}
          >
            {savingPassword && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
            Update Password
          </Button>
        </div>
      </Section>

      {/* ── Team members ── */}
      <Section
        icon={Users}
        title="Team Members"
        description={`You can give up to ${MAX_TEAM_MEMBERS} other people access to your ShowUP workspace.`}
      >
        <div className="space-y-1">
          {/* Owner row */}
          <div className="flex items-center gap-3 py-2.5">
            <Initials name="" email={session.user.email!} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground truncate">{session.user.email}</p>
              <p className="text-xs text-muted-foreground">Owner · you</p>
            </div>
          </div>

          {/* Existing members */}
          {loadingTeam ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-3">
              <Loader2 className="w-4 h-4 animate-spin" /> Loading…
            </div>
          ) : (
            teamMembers.map(member => (
              <div key={member.id} className="flex items-center gap-3 py-2.5 border-t border-border">
                <Initials name={member.name} email={member.email} />
                <div className="min-w-0 flex-1">
                  {member.name && (
                    <p className="text-sm font-medium text-foreground truncate">{member.name}</p>
                  )}
                  <p className={`truncate ${member.name ? "text-xs text-muted-foreground" : "text-sm font-medium text-foreground"}`}>
                    {member.email}
                  </p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    Added {new Date(member.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                  </p>
                </div>
                <button
                  onClick={() => handleRemoveMember(member.id)}
                  disabled={removingId === member.id}
                  className="text-muted-foreground hover:text-destructive transition-colors p-1.5 rounded shrink-0"
                  aria-label="Remove member"
                >
                  {removingId === member.id
                    ? <Loader2 className="w-4 h-4 animate-spin" />
                    : <X className="w-4 h-4" />}
                </button>
              </div>
            ))
          )}

          {/* Invite form */}
          {!loadingTeam && (
            <div className="border-t border-border pt-4 mt-2">
              {canAdd ? (
                <div className="space-y-3">
                  <p className="text-xs text-muted-foreground">
                    {slotsLeft === MAX_TEAM_MEMBERS
                      ? `Add up to ${MAX_TEAM_MEMBERS} team members.`
                      : `${slotsLeft} slot${slotsLeft !== 1 ? "s" : ""} remaining.`}
                  </p>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label>Name</Label>
                      <Input
                        value={inviteName}
                        onChange={e => setInviteName(e.target.value)}
                        placeholder="Jane Smith"
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label>Email</Label>
                      <Input
                        type="email"
                        value={inviteEmail}
                        onChange={e => setInviteEmail(e.target.value)}
                        placeholder="jane@example.com"
                        onKeyDown={e => { if (e.key === "Enter") handleAddMember(); }}
                      />
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    onClick={handleAddMember}
                    disabled={addingMember || !inviteEmail.trim()}
                  >
                    {addingMember
                      ? <><Loader2 className="w-4 h-4 mr-2 animate-spin" />Adding…</>
                      : <><Mail className="w-4 h-4 mr-2" />Add Team Member</>}
                  </Button>
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">
                  You've reached the {MAX_TEAM_MEMBERS}-member limit. Remove a member to add someone new.
                </p>
              )}
            </div>
          )}
        </div>
      </Section>

      {/* ── Billing ── */}
      <Section icon={CreditCard} title="Plan & Billing">
        <div className="space-y-4">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-sm font-semibold text-foreground">Early Access</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Full platform access during the early access period.
              </p>
            </div>
            <span className="text-xs font-medium px-2.5 py-1 rounded-full bg-accent/15 text-accent shrink-0">
              Active
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="bg-muted/40 rounded-lg px-4 py-3">
              <p className="text-2xl font-bold text-foreground">
                {pageCount === null
                  ? <Loader2 className="w-5 h-5 animate-spin inline" />
                  : pageCount}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">Pages generated</p>
            </div>
            <div className="bg-muted/40 rounded-lg px-4 py-3">
              <p className="text-2xl font-bold text-foreground">∞</p>
              <p className="text-xs text-muted-foreground mt-0.5">Included this period</p>
            </div>
          </div>

          <div className="border-t border-border pt-4">
            <p className="text-xs text-muted-foreground">
              Questions about billing or your plan?{" "}
              <a
                href="mailto:hello@showuplocal.com?subject=Billing question"
                className="text-accent hover:underline"
              >
                Contact us →
              </a>
            </p>
          </div>
        </div>
      </Section>
    </div>
  );
}
