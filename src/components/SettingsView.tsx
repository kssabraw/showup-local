import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Users, BarChart3, MapPin, CreditCard, ShieldCheck } from "lucide-react";
import type { Session } from "@supabase/supabase-js";

interface UserRow {
  id: string;
  email: string;
  created_at: string;
  last_sign_in_at: string | null;
  role: string;
}

interface SettingsViewProps {
  session: Session;
  defaultLocation: string;
  onDefaultLocationSaved: (location: string) => void;
}

const SettingsView = ({ session, defaultLocation, onDefaultLocationSaved }: SettingsViewProps) => {
  const { toast } = useToast();
  const [isAdmin, setIsAdmin] = useState(false);

  // Account
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  const [usageCount, setUsageCount] = useState<number | null>(null);

  // Preferences
  const [locationDraft, setLocationDraft] = useState(defaultLocation);
  const [savingLocation, setSavingLocation] = useState(false);

  // Admin
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [updatingRole, setUpdatingRole] = useState<string | null>(null);
  const [adminStats, setAdminStats] = useState({ users: 0, analyses: 0, locations: 0 });

  useEffect(() => {
    fetchRole();
    fetchUsageCount();
  }, []);

  useEffect(() => {
    setLocationDraft(defaultLocation);
  }, [defaultLocation]);

  const fetchRole = async () => {
    const { data } = await supabase
      .from("profiles" as any)
      .select("role")
      .eq("id", session.user.id)
      .single();
    if ((data as any)?.role === "admin") {
      setIsAdmin(true);
      fetchAdminData();
    }
  };

  const fetchUsageCount = async () => {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const { count } = await supabase
      .from("keyword_analyses")
      .select("*", { count: "exact", head: true })
      .gte("created_at", startOfMonth.toISOString());
    setUsageCount(count ?? 0);
  };

  const fetchAdminData = async () => {
    setLoadingUsers(true);
    const [usersRes, analysesRes, locationsRes] = await Promise.all([
      supabase.rpc("get_all_users" as any),
      supabase.from("keyword_analyses").select("*", { count: "exact", head: true }),
      supabase.from("business_profiles").select("*", { count: "exact", head: true }),
    ]);
    if (usersRes.data) setUsers(usersRes.data as UserRow[]);
    setAdminStats({
      users: (usersRes.data as UserRow[])?.length ?? 0,
      analyses: analysesRes.count ?? 0,
      locations: locationsRes.count ?? 0,
    });
    setLoadingUsers(false);
  };

  const handlePasswordChange = async () => {
    if (newPassword !== confirmPassword) {
      toast({ title: "Passwords don't match", variant: "destructive" });
      return;
    }
    if (newPassword.length < 8) {
      toast({ title: "Password must be at least 8 characters", variant: "destructive" });
      return;
    }
    setSavingPassword(true);
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    setSavingPassword(false);
    if (error) {
      toast({ title: "Failed to update password", description: error.message, variant: "destructive" });
    } else {
      toast({ title: "Password updated" });
      setNewPassword("");
      setConfirmPassword("");
    }
  };

  const handleSaveLocation = async () => {
    setSavingLocation(true);
    const { error } = await supabase
      .from("profiles" as any)
      .update({ default_location: locationDraft })
      .eq("id", session.user.id);
    setSavingLocation(false);
    if (error) {
      toast({ title: "Failed to save location", variant: "destructive" });
    } else {
      onDefaultLocationSaved(locationDraft);
      toast({ title: "Default location saved" });
    }
  };

  const handleRoleChange = async (userId: string, newRole: string) => {
    setUpdatingRole(userId);
    const { error } = await supabase
      .from("profiles" as any)
      .update({ role: newRole })
      .eq("id", userId);
    setUpdatingRole(null);
    if (error) {
      toast({ title: "Failed to update role", variant: "destructive" });
    } else {
      setUsers((prev) => prev.map((u) => u.id === userId ? { ...u, role: newRole } : u));
      toast({ title: "Role updated" });
    }
  };

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-display font-bold text-foreground">Settings</h1>
      <p className="text-muted-foreground text-sm mt-1 mb-6">Manage your account, preferences, and workspace.</p>

      <Tabs defaultValue="account">
        <TabsList className={isAdmin ? "grid w-full grid-cols-3" : "grid w-full grid-cols-2"}>
          <TabsTrigger value="account">Account</TabsTrigger>
          <TabsTrigger value="preferences">Preferences</TabsTrigger>
          {isAdmin && <TabsTrigger value="admin">Admin</TabsTrigger>}
        </TabsList>

        {/* ── ACCOUNT ── */}
        <TabsContent value="account" className="space-y-4 mt-4">
          {/* Usage */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <BarChart3 className="w-4 h-4" /> Usage This Month
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex items-center gap-3">
                <span className="text-3xl font-bold">
                  {usageCount === null ? <Loader2 className="w-6 h-6 animate-spin" /> : usageCount}
                </span>
                <span className="text-sm text-muted-foreground">keyword analyses run</span>
              </div>
            </CardContent>
          </Card>

          {/* Plan & Billing */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <CreditCard className="w-4 h-4" /> Plan &amp; Billing
              </CardTitle>
              <CardDescription>Manage your subscription and billing information.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-medium">Free Plan</p>
                  <p className="text-sm text-muted-foreground">Billing &amp; plan management coming soon.</p>
                </div>
                <Badge variant="secondary">Free</Badge>
              </div>
            </CardContent>
          </Card>

          {/* Change Password */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Change Password</CardTitle>
              <CardDescription>Signed in as {session.user.email}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                <Label>New Password</Label>
                <Input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="At least 8 characters"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Confirm Password</Label>
                <Input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Re-enter new password"
                />
              </div>
              <Button onClick={handlePasswordChange} disabled={savingPassword || !newPassword}>
                {savingPassword && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Update Password
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── PREFERENCES ── */}
        <TabsContent value="preferences" className="space-y-4 mt-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <MapPin className="w-4 h-4" /> Default Location
              </CardTitle>
              <CardDescription>
                Pre-fills the location field when running keyword analyses.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1.5">
                <Label>Location</Label>
                <Input
                  value={locationDraft}
                  onChange={(e) => setLocationDraft(e.target.value)}
                  placeholder="e.g. Anaheim, California, United States"
                />
              </div>
              <Button onClick={handleSaveLocation} disabled={savingLocation}>
                {savingLocation && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                Save
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── ADMIN ── */}
        {isAdmin && (
          <TabsContent value="admin" className="space-y-4 mt-4">
            {/* Stats */}
            <div className="grid grid-cols-3 gap-4">
              {[
                { label: "Total Users", value: adminStats.users, icon: Users },
                { label: "Total Analyses", value: adminStats.analyses, icon: BarChart3 },
                { label: "Total Locations", value: adminStats.locations, icon: MapPin },
              ].map(({ label, value, icon: Icon }) => (
                <Card key={label}>
                  <CardContent className="pt-4">
                    <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
                      <Icon className="w-3 h-3" /> {label}
                    </div>
                    <p className="text-2xl font-bold">{value}</p>
                  </CardContent>
                </Card>
              ))}
            </div>

            {/* User management */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4" /> User Management
                </CardTitle>
              </CardHeader>
              <CardContent>
                {loadingUsers ? (
                  <div className="flex items-center gap-2 text-muted-foreground text-sm py-4">
                    <Loader2 className="w-4 h-4 animate-spin" /> Loading users…
                  </div>
                ) : (
                  <div className="divide-y divide-border">
                    {users.map((user) => (
                      <div key={user.id} className="py-3 flex items-center justify-between gap-4">
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate">{user.email}</p>
                          <p className="text-xs text-muted-foreground">
                            Joined {new Date(user.created_at).toLocaleDateString()}
                            {user.last_sign_in_at && (
                              <> · Last seen {new Date(user.last_sign_in_at).toLocaleDateString()}</>
                            )}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {updatingRole === user.id && (
                            <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                          )}
                          <Select
                            value={user.role}
                            onValueChange={(val) => handleRoleChange(user.id, val)}
                            disabled={updatingRole === user.id || user.id === session.user.id}
                          >
                            <SelectTrigger className="w-24 h-8 text-xs">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="user">User</SelectItem>
                              <SelectItem value="admin">Admin</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
};

export default SettingsView;
