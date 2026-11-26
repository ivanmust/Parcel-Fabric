import { useEffect } from "react";
import { useApp } from "../../stores/appStore";
import { AppHeader } from "./AppHeader";
import { MainToolbar } from "../toolbar/MainToolbar";
import { LeftSidebar } from "./LeftSidebar";
import { MapWorkspace } from "../map/MapWorkspace";
import { PropertiesPanel } from "../panels/PropertiesPanel";
import { BottomWorkspace } from "./BottomWorkspace";
import { StatusBar } from "./StatusBar";
import { Toasts } from "../common/Toasts";
import { GoToCoordinatesDialog } from "../dialogs/GoToCoordinatesDialog";
import { ShortcutsDialog } from "../dialogs/ShortcutsDialog";
import { SettingsDialog } from "../dialogs/SettingsDialog";
import { ProfileDialog } from "../dialogs/ProfileDialog";
import { AuditDialog } from "../dialogs/AuditDialog";
import { VersionManagerDialog } from "../dialogs/VersionManagerDialog";
import { SelectByAttributesDialog } from "../dialogs/SelectByAttributesDialog";
import { SelectByLocationDialog } from "../dialogs/SelectByLocationDialog";
import { EditCommandDialogs } from "../dialogs/EditCommandDialogs";
import { ParcelFabricDialogs } from "../dialogs/ParcelFabricDialogs";
import { useKeyboardShortcuts } from "../../hooks/useKeyboardShortcuts";
import { useToolEffects } from "../../hooks/useToolEffects";
import { installClientErrorReporting } from "../../services/logging/clientErrors";

export function Workspace() {
  useKeyboardShortcuts();
  useToolEffects();
  useEffect(() => installClientErrorReporting(), []);
  const leftOpen = useApp((s) => s.leftOpen);
  const rightOpen = useApp((s) => s.rightOpen);
  const canAudit = useApp((s) => !!s.user?.permissions.includes("admin:audit"));

  return (
    <div className="ps-app">
      <AppHeader />
      <MainToolbar />
      <div className="ps-main">
        <LeftSidebar open={leftOpen} />
        <div className="ps-center">
          <MapWorkspace />
          <BottomWorkspace />
        </div>
        <PropertiesPanel open={rightOpen} />
      </div>
      <StatusBar />
      <Toasts />
      <GoToCoordinatesDialog />
      <ShortcutsDialog />
      <SettingsDialog />
      <ProfileDialog />
      {canAudit && <AuditDialog />}
      <VersionManagerDialog />
      <SelectByAttributesDialog />
      <SelectByLocationDialog />
      <EditCommandDialogs />
      <ParcelFabricDialogs />
    </div>
  );
}
