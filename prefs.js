import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export default class TwitchFollowerPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage();
        window.add(page);

        page.add(this._buildCredentialsGroup(settings));
        page.add(this._buildDisplayGroup(settings));
    }

    _buildCredentialsGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Twitch API Credentials',
            description:
                'Enter your Client ID, then click "Authorize with Twitch".\n' +
                'After authorizing, paste the token from the redirect URL into the OAuth Token field below.',
        });

        const clientIdRow = new Adw.EntryRow({
            title: 'Client ID',
            text: settings.get_string('client-id') || '',
            show_apply_button: true,
        });
        clientIdRow.connect('apply', () => {
            settings.set_string('client-id', clientIdRow.text.trim());
        });
        settings.connect('changed::client-id', () => {
            if (settings.get_string('client-id') !== clientIdRow.text)
                clientIdRow.text = settings.get_string('client-id') || '';
        });
        group.add(clientIdRow);

        const authRow = new Adw.ActionRow({
            title: 'Authorize with Twitch',
            subtitle: 'Opens Twitch in your browser to grant access',
        });
        const authBtn = new Gtk.Button({
            label: 'Authorize',
            valign: Gtk.Align.CENTER,
            css_classes: ['pill', 'suggested'],
        });
        authBtn.connect('clicked', () => {
            const clientId = settings.get_string('client-id');
            if (!clientId) return;
            const redirectUri = 'http://localhost';
            const scope = 'user:read:follows';
            const url =
                `https://id.twitch.tv/oauth2/authorize?response_type=token` +
                `&client_id=${encodeURIComponent(clientId)}` +
                `&redirect_uri=${encodeURIComponent(redirectUri)}` +
                `&scope=${encodeURIComponent(scope)}`;
            Gio.AppInfo.launch_default_for_uri(url, null);
        });
        authRow.add_suffix(authBtn);
        group.add(authRow);

        const tokenRow = new Adw.EntryRow({
            title: 'OAuth Token (paste from redirect URL)',
            text: settings.get_string('oauth-token') || '',
            show_apply_button: true,
        });
        tokenRow.connect('apply', () => {
            settings.set_string('oauth-token', tokenRow.text.trim());
        });
        settings.connect('changed::oauth-token', () => {
            if (settings.get_string('oauth-token') !== tokenRow.text)
                tokenRow.text = settings.get_string('oauth-token') || '';
        });
        group.add(tokenRow);

        return group;
    }

    _buildDisplayGroup(settings) {
        const group = new Adw.PreferencesGroup({
            title: 'Display',
        });

        const sortRow = new Adw.ComboRow({
            title: 'Sort Channels By',
            model: this._buildSortModel(),
            selected: this._sortIndex(settings.get_string('sort-mode')),
        });
        sortRow.connect('notify::selected', () => {
            const modes = ['viewers', 'follow-date', 'alphabetical'];
            settings.set_string('sort-mode', modes[sortRow.selected]);
        });
        settings.connect('changed::sort-mode', () => {
            sortRow.selected = this._sortIndex(
                settings.get_string('sort-mode'),
            );
        });
        group.add(sortRow);

        const intervalRow = new Adw.SpinRow({
            title: 'Refresh Interval (seconds)',
            adjustment: new Gtk.Adjustment({
                value: settings.get_int('refresh-interval'),
                lower: 30,
                upper: 300,
                step_increment: 10,
                page_increment: 60,
            }),
        });
        intervalRow.connect('changed', () => {
            settings.set_int('refresh-interval', intervalRow.value);
        });
        settings.connect('changed::refresh-interval', () => {
            if (settings.get_int('refresh-interval') !== intervalRow.value)
                intervalRow.value = settings.get_int('refresh-interval');
        });
        group.add(intervalRow);

        const offlineRow = new Adw.SwitchRow({
            title: 'Show Offline Channels',
            active: settings.get_boolean('show-offline'),
        });
        offlineRow.connect('notify::active', () => {
            settings.set_boolean('show-offline', offlineRow.active);
        });
        settings.connect('changed::show-offline', () => {
            if (settings.get_boolean('show-offline') !== offlineRow.active)
                offlineRow.active = settings.get_boolean('show-offline');
        });
        group.add(offlineRow);

        return group;
    }

    _buildSortModel() {
        return new Gtk.StringList({
            strings: ['Most Viewers', 'Follow Date', 'Alphabetical'],
        });
    }

    _sortIndex(mode) {
        const map = { viewers: 0, 'follow-date': 1, alphabetical: 2 };
        return map[mode] ?? 0;
    }
}
