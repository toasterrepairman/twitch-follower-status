import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import Soup from 'gi://Soup';
import Clutter from 'gi://Clutter';

const TWITCH_API = 'https://api.twitch.tv/helix';

const SortMode = {
    VIEWERS: 'viewers',
    FOLLOW_DATE: 'follow-date',
    ALPHABETICAL: 'alphabetical',
};

function httpGet(session, url, headers) {
    return new Promise((resolve, reject) => {
        const message = new Soup.Message({
            method: 'GET',
            uri: GLib.Uri.parse(url, GLib.UriFlags.NONE),
        });
        for (const [key, value] of Object.entries(headers))
            message.request_headers.append(key, value);

        session.send_and_read_async(
            message,
            GLib.PRIORITY_DEFAULT,
            null,
            (sess, result) => {
                try {
                    const bytes = sess.send_and_read_finish(result);
                    if (!bytes) {
                        reject(new Error('Empty response'));
                        return;
                    }
                    if (message.status_code === 401) {
                        reject(new Error('Unauthorized — check your credentials'));
                        return;
                    }
                    if (message.status_code !== 200) {
                        const body = new TextDecoder().decode(bytes.get_data());
                        reject(new Error(`HTTP ${message.status_code}: ${body}`));
                        return;
                    }
                    resolve(JSON.parse(new TextDecoder().decode(bytes.get_data())));
                } catch (e) {
                    reject(e);
                }
            },
        );
    });
}

function formatViewers(n) {
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
    return `${n}`;
}

function formatUptime(startedAt) {
    const diff = Date.now() - new Date(startedAt).getTime();
    const h = Math.floor(diff / 3_600_000);
    const m = Math.floor((diff % 3_600_000) / 60_000);
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

const TwitchFollowerIndicator = GObject.registerClass(
class TwitchFollowerIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.5, 'Twitch Follower Status', false);

        this._extension = extension;
        this._settings = extension.getSettings();
        this._path = extension.path;

        this._userId = null;
        this._followedChannels = [];
        this._liveStreams = new Map();
        this._session = new Soup.Session({ timeout: 15 });
        this._refreshTimer = null;
        this._refreshing = false;
        this._settingsConnections = [];

        this._buildPanelButton();
        this._buildPopover();
        this._connectSettings();
        this._startRefresh();
    }

    _buildPanelButton() {
        const box = new St.BoxLayout({
            vertical: false,
            style_class: 'panel-status-menu-box',
        });

        const iconFile = Gio.File.new_for_path(
            `${this._path}/icons/twitch-symbolic.svg`,
        );
        const gicon = new Gio.FileIcon({ file: iconFile });
        box.add_child(
            new St.Icon({ gicon, style_class: 'system-status-icon' }),
        );

        this._countLabel = new St.Label({
            text: '',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'twitch-panel-count',
        });
        box.add_child(this._countLabel);

        this.add_child(box);
    }

    _buildPopover() {
        this._buildSortHeader();
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._buildChannelList();
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._buildFooter();
    }

    _buildSortHeader() {
        const headerBox = new St.BoxLayout({
            vertical: false,
            style_class: 'twitch-sort-header',
            x_expand: true,
        });

        const modes = [
            [SortMode.VIEWERS, 'Viewers'],
            [SortMode.FOLLOW_DATE, 'Followed'],
            [SortMode.ALPHABETICAL, 'A\u2013Z'],
        ];

        this._sortButtons = new Map();
        const current = this._settings.get_string('sort-mode');

        for (const [id, label] of modes) {
            const btn = new St.Button({
                label,
                style_class: 'twitch-sort-btn',
                can_focus: true,
                x_expand: true,
            });
            if (id === current) btn.add_style_class_name('active');
            btn.connect('clicked', () => {
                this._settings.set_string('sort-mode', id);
            });
            this._sortButtons.set(id, btn);
            headerBox.add_child(btn);
        }

        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        item.add_child(headerBox);
        this.menu.addMenuItem(item);
    }

    _buildChannelList() {
        this._scrollView = new St.ScrollView({
            style_class: 'twitch-scroll',
            overlay_scrollbars: true,
        });
        this._scrollView.set_policy(
            St.PolicyType.NEVER,
            St.PolicyType.AUTOMATIC,
        );
        this._scrollView.set_height(420);

        this._listBox = new St.BoxLayout({
            vertical: true,
            style_class: 'twitch-list',
        });
        this._scrollView.add_child(this._listBox);

        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        item.add_child(this._scrollView);
        this.menu.addMenuItem(item);
    }

    _buildFooter() {
        const footerBox = new St.BoxLayout({
            vertical: false,
            style_class: 'twitch-footer',
            x_expand: true,
        });

        this._statusLabel = new St.Label({
            text: 'Configure credentials in settings',
            style_class: 'twitch-status',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        footerBox.add_child(this._statusLabel);

        const refreshBtn = new St.Button({
            label: '\u27F3',
            style_class: 'twitch-refresh-btn',
            can_focus: true,
        });
        refreshBtn.connect('clicked', () => this._refresh());
        footerBox.add_child(refreshBtn);

        const item = new PopupMenu.PopupBaseMenuItem({
            reactive: false,
            can_focus: false,
        });
        item.add_child(footerBox);
        this.menu.addMenuItem(item);
    }

    _connectSettings() {
        const addConn = (key, fn) => {
            const id = this._settings.connect(`changed::${key}`, fn);
            this._settingsConnections.push(id);
        };

        addConn('sort-mode', () => {
            const mode = this._settings.get_string('sort-mode');
            for (const [id, btn] of this._sortButtons) {
                btn.toggle_style_class_name('active', id === mode);
            }
            this._rebuildList();
        });

        addConn('show-offline', () => this._rebuildList());

        addConn('client-id', () => {
            this._userId = null;
        });
        addConn('oauth-token', () => {
            this._userId = null;
        });
    }

    _startRefresh() {
        this._refresh();
        const interval = this._settings.get_int('refresh-interval');
        this._refreshTimer = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            interval,
            () => {
                this._refresh();
                return GLib.SOURCE_CONTINUE;
            },
        );
    }

    async _refresh() {
        if (this._refreshing) return;
        this._refreshing = true;
        this._statusLabel.set_text('Refreshing\u2026');

        const clientId = this._settings.get_string('client-id');
        const token = this._settings.get_string('oauth-token');

        if (!clientId || !token) {
            this._statusLabel.set_text('Configure credentials in settings');
            this._clearList();
            this._countLabel.set_text('');
            this._refreshing = false;
            return;
        }

        const headers = {
            Authorization: `Bearer ${token}`,
            'Client-Id': clientId,
        };

        try {
            if (!this._userId) {
                const user = await httpGet(
                    this._session,
                    `${TWITCH_API}/users`,
                    headers,
                );
                if (!user.data?.length)
                    throw new Error('Could not identify Twitch user');
                this._userId = user.data[0].id;
            }

            this._followedChannels = await this._fetchFollowed(headers);
            this._liveStreams = await this._fetchStreams(headers);

            this._rebuildList();

            const liveCount = this._liveStreams.size;
            this._countLabel.set_text(liveCount > 0 ? ` ${liveCount}` : '');
            this._statusLabel.set_text(
                `Updated ${new Date().toLocaleTimeString()}`,
            );
        } catch (e) {
            log(`[TwitchFollower] ${e.message}`);
            this._statusLabel.set_text(e.message);
            if (e.message.includes('Unauthorized')) this._userId = null;
        }

        this._refreshing = false;
    }

    async _fetchFollowed(headers) {
        let channels = [];
        let cursor = null;

        do {
            let url = `${TWITCH_API}/channels/followed?user_id=${this._userId}&first=100`;
            if (cursor) url += `&after=${cursor}`;

            const data = await httpGet(this._session, url, headers);
            if (data.data) channels = channels.concat(data.data);
            cursor = data.pagination?.cursor ?? null;
        } while (cursor);

        return channels;
    }

    async _fetchStreams(headers) {
        const streams = new Map();
        const logins = this._followedChannels.map(
            (c) => c.broadcaster_login,
        );

        for (let i = 0; i < logins.length; i += 100) {
            const batch = logins.slice(i, i + 100);
            const params = batch
                .map((l) => `user_login=${encodeURIComponent(l)}`)
                .join('&');

            try {
                const data = await httpGet(
                    this._session,
                    `${TWITCH_API}/streams?${params}`,
                    headers,
                );
                if (data.data) {
                    for (const s of data.data)
                        streams.set(s.user_login.toLowerCase(), s);
                }
            } catch (e) {
                log(`[TwitchFollower] streams: ${e.message}`);
            }
        }

        return streams;
    }

    _rebuildList() {
        this._clearList();

        const sortMode = this._settings.get_string('sort-mode');
        const showOffline = this._settings.get_boolean('show-offline');

        let items = this._followedChannels.map((ch) => {
            const stream = this._liveStreams.get(
                ch.broadcaster_login.toLowerCase(),
            );
            return {
                ...ch,
                stream: stream ?? null,
                isLive: !!stream,
                viewers: stream?.viewer_count ?? 0,
            };
        });

        if (!showOffline) items = items.filter((i) => i.isLive);

        items.sort((a, b) => {
            if (a.isLive !== b.isLive) return a.isLive ? -1 : 1;

            switch (sortMode) {
                case SortMode.VIEWERS:
                    return b.viewers - a.viewers;
                case SortMode.FOLLOW_DATE:
                    return (
                        new Date(a.followed_at) - new Date(b.followed_at)
                    );
                case SortMode.ALPHABETICAL:
                    return a.broadcaster_name.localeCompare(
                        b.broadcaster_name,
                    );
                default:
                    return 0;
            }
        });

        if (items.length === 0) {
            this._listBox.add_child(
                new St.Label({
                    text: showOffline
                        ? 'No followed channels found'
                        : 'No channels are live',
                    style_class: 'twitch-empty',
                }),
            );
            return;
        }

        for (const item of items)
            this._listBox.add_child(this._createItem(item));
    }

    _createItem(ch) {
        const row = new St.BoxLayout({
            vertical: false,
            style_class: `twitch-item ${ch.isLive ? 'live' : 'offline'}`,
            x_expand: true,
            reactive: true,
        });

        const avatarBin = new St.Bin({
            style_class: `twitch-avatar ${ch.isLive ? 'live' : 'offline'}`,
            width: 34,
            height: 34,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        avatarBin.set_child(
            new St.Label({
                text: ch.broadcaster_name.charAt(0).toUpperCase(),
                style_class: 'twitch-avatar-letter',
            }),
        );
        row.add_child(avatarBin);

        const info = new St.BoxLayout({
            vertical: true,
            style_class: 'twitch-item-info',
            x_expand: true,
        });
        info.add_child(
            new St.Label({
                text: ch.broadcaster_name,
                style_class: `twitch-item-name ${ch.isLive ? 'live' : ''}`,
            }),
        );
        if (ch.isLive && ch.stream) {
            info.add_child(
                new St.Label({
                    text: ch.stream.game_name || 'No category',
                    style_class: 'twitch-item-game',
                }),
            );
        }
        row.add_child(info);

        const meta = new St.BoxLayout({
            vertical: true,
            style_class: 'twitch-item-meta',
        });

        if (ch.isLive) {
            meta.add_child(
                new St.Label({
                    text: '\u25CF LIVE',
                    style_class: 'twitch-live-dot',
                }),
            );
            meta.add_child(
                new St.Label({
                    text: formatViewers(ch.viewers),
                    style_class: 'twitch-viewers',
                }),
            );
            meta.add_child(
                new St.Label({
                    text: formatUptime(ch.stream.started_at),
                    style_class: 'twitch-uptime',
                }),
            );
        } else {
            meta.add_child(
                new St.Label({
                    text: 'Offline',
                    style_class: 'twitch-offline',
                }),
            );
        }
        row.add_child(meta);

        row.connect('button-release-event', () => {
            Gio.AppInfo.launch_default_for_uri(
                `https://twitch.tv/${ch.broadcaster_login}`,
                null,
            );
        });

        return row;
    }

    _clearList() {
        let child;
        while ((child = this._listBox.get_first_child()))
            this._listBox.remove_child(child);
    }

    destroy() {
        if (this._refreshTimer) {
            GLib.source_remove(this._refreshTimer);
            this._refreshTimer = null;
        }
        for (const id of this._settingsConnections)
            this._settings.disconnect(id);
        this._settingsConnections = [];
        this._session.abort();
        super.destroy();
    }
});

export default class TwitchFollowerExtension extends Extension {
    enable() {
        this._indicator = new TwitchFollowerIndicator(this);
        Main.panel.addToStatusArea('twitch-follower-status', this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
