const EXT_ID = 'brief@mozdev.org';
const TEMPLATE_FILENAME = 'feedview-template.html';
const DEFAULT_STYLE_PATH = 'chrome://brief/skin/feedview.css'
const LAST_MAJOR_VERSION = 0.7;
const RELEASE_NOTES_URL = 'http://brief.mozdev.org/newversion.html';

const Cc = Components.classes;
const Ci = Components.interfaces;

const gStorage = Cc['@ancestor/brief/storage;1'].getService(Ci.nsIBriefStorage);
var QuerySH = Components.Constructor('@ancestor/brief/query;1', 'nsIBriefQuery', 'setConditions');
var Query = Components.Constructor('@ancestor/brief/query;1', 'nsIBriefQuery');

const ENTRY_STATE_NORMAL = Ci.nsIBriefQuery.ENTRY_STATE_NORMAL;
const ENTRY_STATE_TRASHED = Ci.nsIBriefQuery.ENTRY_STATE_TRASHED;
const ENTRY_STATE_DELETED = Ci.nsIBriefQuery.ENTRY_STATE_DELETED;
const ENTRY_STATE_ANY = Ci.nsIBriefQuery.ENTRY_STATE_ANY;

var gFeedView;
var gTemplateURI;
var gFeedViewStyle;

var brief = {

    briefLoaded: false,
    browserWindow: null,

    init: function(aEvent) {
        if (this.briefLoaded)
            return;
        this.briefLoaded = true;

        gPrefs.register();
        gFeedViewStyle = this.getFeedViewStyle();

        // Get the extension's directory.
        var itemLocation = Cc['@mozilla.org/extensions/manager;1'].
                           getService(Ci.nsIExtensionManager).
                           getInstallLocation(EXT_ID).
                           getItemLocation(EXT_ID);
        // Get the template file.
        itemLocation.append('defaults');
        itemLocation.append('data');
        itemLocation.append(TEMPLATE_FILENAME);
        // Create URI of the template file.
        gTemplateURI = Cc['@mozilla.org/network/protocol;1?name=file'].
                       getService(Ci.nsIFileProtocolHandler).
                       newFileURI(itemLocation);

        // Initiate the feed list.
        var liveBookmarksFolder = gPrefs.getCharPref('liveBookmarksFolder');
        if (liveBookmarksFolder) {
            // If Brief is set as the homepage, it's loaded before delayedStartup() is
            // run and encounters an exception when synchronizing. Hence the timeout.
            //setTimeout(function(){ gStorage.syncWithBookmarks(); }, 500);
            gStorage.syncWithBookmarks();
            // This timeout causes the Brief window to be displayed a lot sooner and to
            // populate the feed list afterwards.
            setTimeout(function(){ gFeedList.rebuild(); }, 0);
        }
        else {
            // If no Live Bookmarks folder has been picked yet, offer a button to do it.
            var deck = document.getElementById('feed-list-deck');
            deck.selectedIndex = 1;
        }

        this.browserWindow = window.QueryInterface(Ci.nsIInterfaceRequestor).
                                    getInterface(Ci.nsIWebNavigation).
                                    QueryInterface(Ci.nsIDocShellTreeItem).
                                    rootTreeItem.
                                    QueryInterface(Ci.nsIInterfaceRequestor).
                                    getInterface(Ci.nsIDOMWindow);

        var viewConstraintList = document.getElementById('view-constraint-list');
        viewConstraintList.selectedIndex = gPrefs.shownEntries == 'all' ? 0 :
                                           gPrefs.shownEntries == 'unread' ? 1 : 2;

        var observerService = Cc["@mozilla.org/observer-service;1"].
                              getService(Ci.nsIObserverService);
        observerService.addObserver(this, 'brief:feed-updated', false);
        observerService.addObserver(this, 'brief:feed-loading', false);
        observerService.addObserver(this, 'brief:feed-error', false);
        observerService.addObserver(this, 'brief:entry-status-changed', false);
        observerService.addObserver(this, 'brief:invalidate-feedlist', false);
        observerService.addObserver(this, 'brief:batch-update-started', false);

        // Load the initial Unread view or the new version page.
        var prevLastMajorVersion = gPrefs.getCharPref('lastMajorVersion');
        if (parseFloat(prevLastMajorVersion) < LAST_MAJOR_VERSION) {
            var browser = document.getElementById('feed-view');
            browser.loadURI(RELEASE_NOTES_URL);
            gPrefs.setCharPref('lastMajorVersion', LAST_MAJOR_VERSION);
        }
        else if (gPrefs.getBoolPref('showHomeView')) {
            setTimeout(function() { gFeedList.tree.view.selection.select(0); }, 0);
        }
    },


    unload: function() {
        var observerService = Cc["@mozilla.org/observer-service;1"].
                              getService(Ci.nsIObserverService);
        observerService.removeObserver(this, 'brief:feed-updated');
        observerService.removeObserver(this, 'brief:feed-loading');
        observerService.removeObserver(this, 'brief:feed-error');
        observerService.removeObserver(this, 'brief:invalidate-feedlist');
        observerService.removeObserver(this, 'brief:entry-status-changed');
        observerService.removeObserver(this, 'brief:batch-update-started');
        gPrefs.unregister();

        // Persist the folders open/closed state.
        var items = gFeedList.tree.getElementsByTagName('treeitem');
        var closedFolders = '';
        for (var i = 0; i < items.length; i++) {
            var item = items[i];
            if (item.hasAttribute('container') && item.getAttribute('open') == 'false')
                closedFolders += item.getAttribute('feedId');
        }
        gFeedList.tree.setAttribute('closedFolders', closedFolders);
    },


    // Storage and UpdateService components communicate with us through global
    // notifications.
    observe: function(aSubject, aTopic, aData) {
        switch (aTopic) {
        // A feed update was finished and new entries are available. Restore the
        // favicon instead of the throbber (or error icon), refresh the feed treeitem
        // and the feedview if necessary.
        case 'brief:feed-updated':
            var feedId = aData;
            var item = gFeedList.getTreeitemForFeed(feedId);
            item.removeAttribute('error');
            item.removeAttribute('loading');
            gFeedList.refreshFeedTreeitems(item);
            this.finishedFeeds++;
            this.updateProgressMeter();

            if (aSubject.QueryInterface(Ci.nsIVariant) > 0) {
              gFeedList.refreshSpecialTreeitem('unread-folder');
              if (gFeedView)
                gFeedView.ensure();
            }
            break;

        // A feed was requested, show throbber as its icon.
        case 'brief:feed-loading':
            var item = gFeedList.getTreeitemForFeed(aData);
            item.setAttribute('loading', true);
            gFeedList.refreshFeedTreeitems(item);
            break;

        // An error occured when downloading or parsing a feed, show error icon.
        case 'brief:feed-error':
            var feedId = aData;
            var item = gFeedList.getTreeitemForFeed(feedId);
            gFeedList.removeProperty(item, 'loading');
            item.setAttribute('error', true);
            gFeedList.refreshFeedTreeitems(item);
            this.finishedFeeds++;
            this.updateProgressMeter();
            break;

        // The Live Bookmarks stored is user's folder of choice were read and the
        // in-database list of feeds was synchronized. Rebuild the feed list as it
        // may have changed.
        case 'brief:feedlist-invalidate':
            gFeedList.rebuild();
            var deck = document.getElementById('feed-list-deck');
            deck.selectedIndex = 0;
            break;

        // Sets up the updating progressmeter.
        case 'brief:batch-update-started':
            var progressmeter = document.getElementById('update-progress');
            progressmeter.hidden = false;
            progressmeter.value = 0;
            this.totalFeeds = gStorage.getAllFeeds({}).length;
            this.finishedFeeds = 0;
            break;

        // Entries were marked as read/unread, starred, trashed, restored, or deleted.
        case 'brief:entry-status-changed':
            this.onEntryStatusChanged(aSubject, aData);
            break;
        }
    },

    // Updates the approperiate treeitems in the feed list and refreshes the feedview
    // when necessary.
    onEntryStatusChanged: function(aChangedItems, aChangeType) {
        aChangedItems.QueryInterface(Ci.nsIWritablePropertyBag2);
        var changedFeeds = aChangedItems.getPropertyAsAUTF8String('feedIdList').
                                         match(/[^ ]+/g);
        var changedEntries = aChangedItems.getPropertyAsAUTF8String('entryIdList').
                                           match(/[^ ]+/g);

        var viewIsCool = true;
        if (gFeedView)
            viewIsCool = gFeedView.ensure();

        switch (aChangeType) {
        case 'unread':
        case 'read':
            // Just visually mark the changed entries as read/unread.
            if (gFeedView && gFeedView.isActive && viewIsCool) {
                var nodes = gFeedView.feedContent.childNodes;
                for (i = 0; i < nodes.length; i++) {
                    if (changedEntries.indexOf(nodes[i].id) != -1) {
                        if (aChangeType == 'read')
                            nodes[i].setAttribute('read', 'true');
                        else
                            nodes[i].removeAttribute('read');
                    }
                }
            }

            gFeedList.refreshFeedTreeitems(changedFeeds);

            // We can't know if any of those need updating, so we have to
            // update them all.
            gFeedList.refreshSpecialTreeitem('unread-folder');
            gFeedList.refreshSpecialTreeitem('starred-folder');
            gFeedList.refreshSpecialTreeitem('trash-folder');
            break;

        case 'starred':
            gFeedList.refreshSpecialTreeitem('starred-folder');
            break;

        case 'deleted':
            gFeedList.refreshFeedTreeitems(changedFeeds);

            gFeedList.refreshSpecialTreeitem('unread-folder');
            gFeedList.refreshSpecialTreeitem('starred-folder');
            gFeedList.refreshSpecialTreeitem('trash-folder');
            break;
        }
    },


    // Returns a string containing the style of the feed view.
    getFeedViewStyle: function() {
        if (gPrefs.getBoolPref('feedview.useCustomStyle')) {
            var pref = gPrefs.getComplexValue('feedview.customStylePath',
                                              Ci.nsISupportsString);
            var url = 'file:///' + pref.data;
        }
        else {
            var url = DEFAULT_STYLE_PATH;
        }

        var request = new XMLHttpRequest;
        request.open('GET', url, false);
        request.send(null);

        return request.responseText;
    },


    updateProgressMeter: function() {
        var progressmeter = document.getElementById('update-progress');
        var percentage = 100 * this.finishedFeeds / this.totalFeeds;
        progressmeter.value = percentage;

        if (percentage == 100)
            progressmeter.hidden = true;
    },

// Listeners for actions performed in the feed view.

    onMarkEntryRead: function(aEvent) {
        var entryID = aEvent.target.getAttribute('id');
        var readStatus = aEvent.target.hasAttribute('read');
        var query = new QuerySH(null, entryID, null);
        gStorage.markEntriesRead(readStatus, query);
    },

    onDeleteEntry: function(aEvent) {
        var entryID = aEvent.target.getAttribute('id');
        var query = new QuerySH(null, entryID, null);
        gStorage.deleteEntries(1, query);
    },

    onRestoreEntry: function(aEvent) {
        var entryID = aEvent.target.getAttribute('id');
        var query = new QuerySH(null, entryID, null);
        gStorage.deleteEntries(0, query);
    },

    onStarEntry: function(aEvent) {
        var entryID = aEvent.target.getAttribute('id');
        var newStatus = aEvent.target.hasAttribute('starred');
        var query = new QuerySH(null, entryID, null);
        gStorage.starEntries(newStatus, query);
    },

    onFeedViewClick: function(aEvent) {
        var anonid = aEvent.originalTarget.getAttribute('anonid');
        var targetEntry = aEvent.target;

        if (anonid == 'article-title-link' && (aEvent.button == 0 || aEvent.button == 1)) {

            if (aEvent.button == 0 && gPrefs.getBoolPref('feedview.openEntriesInTabs')) {
                aEvent.preventDefault();
                var url = targetEntry.getAttribute('entryURL');
                brief.browserWindow.gBrowser.loadOneTab(url);
            }

            if (!targetEntry.hasAttribute('read') &&
               gPrefs.getBoolPref('feedview.linkMarksRead')) {
                targetEntry.setAttribute('read', true);
                var id = targetEntry.getAttribute('id');
                var query = new QuerySH(null, id, null);
                gStorage.markEntriesRead(true, query);
            }
        }
    },

// Toolbar commands.

    toggleLeftPane: function(aEvent) {
        var pane = document.getElementById('left-pane');
        var splitter = document.getElementById('left-pane-splitter');
        pane.hidden = splitter.hidden = !pane.hidden;
    },

    updateAllFeeds: function() {
        var updateService = Cc['@ancestor/brief/updateservice;1'].
                            getService(Ci.nsIBriefUpdateService);
        updateService.fetchAllFeeds();
    },

    openOptions: function(aPaneID) {
        window.openDialog('chrome://brief/content/options/options.xul', 'Brief options',
                          'chrome,titlebar,toolbar,centerscreen,modal,resizable');
    },

    onConstraintListCmd: function(aEvent) {
        var choice = aEvent.target.id;
        var prefValue = choice == 'show-all' ? 'all' :
                        choice == 'show-unread' ? 'unread' : 'starred';

        gPrefs.setCharPref('feedview.shownEntries', prefValue);
        gFeedView.ensure();
    },


    markCurrentViewRead: function(aNewStatus) {
        gStorage.markEntriesRead(aNewStatus, gFeedView.query);
    },

    // Creates and manages the FeedView displaying the search results, based the current
    // input string and the search scope.
    performSearch: function(aEvent) {
        var searchbar = document.getElementById('searchbar');
        var bundle = document.getElementById('main-bundle');
        var title = bundle.getFormattedString('searchResults', [searchbar.value]);

        // If there's no feed view and the search scope is "current view" then do nothing.
        if (searchbar.searchScope == 0 && !gFeedView)
            return;

        // A new search is being started.
        if (searchbar.value && gFeedView && !gFeedView.query.searchString) {
            // Remember the old view to restore it after the search is finished.
            this.previousView = gFeedView;

            // For a global search we deselect items in the feed list.
            // We need to suppress selection so that gFeedList.onselect() isn't used.
            // nsITreeSelection.selectEventsSuppressed doesn't seem to work here, so
            // we have to set our own flag which we will check in onselect().
            if (searchbar.searchScope == 1) {
                var selection = gFeedList.tree.view.selection;
                gFeedList.selectEventsSuppressed = true;
                selection.clearSelection();
                gFeedList.selectEventsSuppressed = false;
            }
        }

        // The search has finished.
        if (!searchbar.value && gFeedView && gFeedView.query.searchString) {
            if (this.previousView)
                gFeedView = this.previousView;
            gFeedView.query.searchString = gFeedView.titleOverride = '';
            gFeedView.ensure();
            return;
        }

        // If the search scope is set to "global" and there is no view or it is not
        // a global search view, then let's create it.
        if ((searchbar.searchScope == 1 && !gFeedView.isGlobalSearch) ||
           (searchbar.searchScope == 1 && !gFeedView)) {
            var query = new Query();
            query.searchString = searchbar.value;
            gFeedView = new FeedView(title, query);
            return;
        }

        gFeedView.titleOverride = title;
        gFeedView.query.searchString = searchbar.value;
        gFeedView.ensure();
    },

// Feed list context menu commands.

    ctx_markFeedRead: function(aEvent) {
        var item = gFeedList.ctx_targetItem;
        var feedId = gFeedList.ctx_targetItem.getAttribute('feedId');
        var query = new QuerySH(feedId, null, null);
        gStorage.markEntriesRead(true, query);
    },

    ctx_markFolderRead: function(aEvent) {
        var targetItem = gFeedList.ctx_targetItem;

        if (targetItem.hasAttribute('specialFolder')) {
            var query = new Query();
            if (targetItem.id == 'unread-folder')
                query.unread = true;
            else if (targetItem.id == 'starred-folder')
                query.starred = true;
            else
                query.deleted = ENTRY_STATE_TRASHED;
            gStorage.markEntriesRead(true, query);
        }
        else {
            var query = new Query();
            query.folders = targetItem.getAttribute('feedId');
            gStorage.markEntriesRead(true, query);
        }
    },

    ctx_updateFeed: function(aEvent) {
        var feedId = gFeedList.ctx_targetItem.getAttribute('feedId');
        var updateService = Cc['@ancestor/brief/updateservice;1'].
                            getService(Ci.nsIBriefUpdateService);
        updateService.fetchFeed(feedId);
    },

    ctx_openWebsite: function(aEvent) {
        var feedId = gFeedList.ctx_targetItem.getAttribute('feedId');
        var url = gStorage.getFeed(feedId).websiteURL;
        brief.browserWindow.gBrowser.loadOneTab(url);
    },

    ctx_emptyFeed: function(aEvent) {
        var feedId = gFeedList.ctx_targetItem.getAttribute('feedId');
        var query = new QuerySH(feedId, null, null);
        query.unstarred = true;
        gStorage.deleteEntries(ENTRY_STATE_TRASHED, query);
    },

    ctx_emptyFolder: function(aEvent) {
        var targetItem = gFeedList.ctx_targetItem;

        if (targetItem.id == 'unread-folder') {
            var query = new Query();
            query.unstarred = true;
            query.unread = true;
            gStorage.deleteEntries(ENTRY_STATE_TRASHED, query);
        }
        else {
            var query = new Query();
            query.folders = targetItem.getAttribute('feedId');
            query.unstarred = true;
            gStorage.deleteEntries(ENTRY_STATE_TRASHED, query);
        }
    },

    ctx_restoreTrashed: function(aEvent) {
        var query = new Query();
        query.deleted = ENTRY_STATE_TRASHED;
        gStorage.deleteEntries(ENTRY_STATE_NORMAL, query);
    },

    ctx_emptyTrash: function(aEvent) {
        var query = new Query();
        query.trashed = true;
        gStorage.deleteEntries(ENTRY_STATE_DELETED, query);
    }

}


var gPrefs = {

    register: function() {
        this._branch = Cc['@mozilla.org/preferences-service;1'].
                       getService(Ci.nsIPrefService).
                       getBranch('extensions.brief.').
                       QueryInterface(Ci.nsIPrefBranch2);

        this.getIntPref = this._branch.getIntPref;
        this.getBoolPref = this._branch.getBoolPref;
        this.getCharPref = this._branch.getCharPref;
        this.getComplexValue = this._branch.getComplexValue;

        this.setIntPref = this._branch.setIntPref;
        this.setBoolPref = this._branch.setBoolPref;
        this.setCharPref = this._branch.setCharPref;

        // Cache prefs access to which is critical for performance.
        this.entriesPerPage = this.getIntPref('feedview.entriesPerPage');
        this.shownEntries = this.getCharPref('feedview.shownEntries');
        this.doubleClickMarks = this.getBoolPref('feedview.doubleClickMarks');

        this._branch.addObserver('', this, false);
    },

    unregister: function() {
        this._branch.removeObserver('', this);
    },

    observe: function(aSubject, aTopic, aData) {
        if (aTopic != 'nsPref:changed')
            return;
        switch (aData) {
            case 'showFavicons':
                var feeds = gStorage.getAllFeeds({});
                for (var i = 0; i < feeds.length; i++)
                    gFeedList.refreshFeedTreeitem(feeds[i].feedId);
                break;

            case 'feedview.customStylePath':
                if (this.getBoolPref('feedview.useCustomStyle'))
                    gFeedViewStyle = brief.getFeedViewStyle();
                break;

            case 'feedview.useCustomStyle':
                gFeedViewStyle = brief.getFeedViewStyle();
                break;

            // Observers to keep the cached prefs up to date.
            case 'feedview.entriesPerPage':
                this.entriesPerPage = this.getIntPref('feedview.entriesPerPage');
                break;
            case 'feedview.shownEntries':
                this.shownEntries = this.getCharPref('feedview.shownEntries');
                break;
            case 'feedview.doubleClickMarks':
                this.doubleClickMarks = this.getBoolPref('feedview.doubleClickMarks');
                break;
        }
    }

}

function dump(aMessage) {
  var consoleService = Cc['@mozilla.org/consoleservice;1'].
                       getService(Ci.nsIConsoleService);
  consoleService.logStringMessage(aMessage);
}
