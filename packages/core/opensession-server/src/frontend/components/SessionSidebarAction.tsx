import { Button } from "../ui/button";
import { Menu, MENU_ICON } from "../ui/menu";
import { IconUnarchive } from "./icons";
import { KeepInSidebarIcon } from "./sidebar/KeepInSidebarMark";

type SessionSidebarActionProps = {
  archived: boolean;
  canKeepInSidebar: boolean;
  inMenu: boolean;
  onKeepInSidebar: () => void;
  onUnarchive?: () => void;
};

export function SessionSidebarAction({
  archived,
  canKeepInSidebar,
  inMenu,
  onKeepInSidebar,
  onUnarchive,
}: SessionSidebarActionProps) {
  const action =
    archived && onUnarchive
      ? { label: "Unarchive", Icon: IconUnarchive, onClick: onUnarchive }
      : canKeepInSidebar
        ? {
            label: "Add to sidebar",
            Icon: KeepInSidebarIcon,
            onClick: onKeepInSidebar,
          }
        : null;
  if (!action) return null;
  const { Icon, label, onClick } = action;

  return inMenu ? (
    <Menu.Item onClick={onClick} title={label}>
      <Icon className={MENU_ICON} />
      <span className="grow">{label}</span>
    </Menu.Item>
  ) : (
    <Button
      size="md"
      variant="default"
      className="mr-1.5 text-fg"
      icon={<Icon />}
      iconTone="full"
      onClick={onClick}
      title={label}
    >
      {label}
    </Button>
  );
}
