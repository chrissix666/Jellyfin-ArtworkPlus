// The types that moved between Jellyfin 10.10 (net8.0 build)
// and Jellyfin 12.1 (net10.0 build). One place, so the controllers compile unchanged for both targets.
//   User      Jellyfin.Data.Entities (10.10)  ->  Jellyfin.Database.Implementations.Entities (12.1)
//   SortOrder Jellyfin.Data.Enums (10.10)     ->  Jellyfin.Database.Implementations.Enums (12.1)
//             (ItemSortBy stays in Jellyfin.Data.Enums on both)
#if NET10_0_OR_GREATER
global using JfUser = Jellyfin.Database.Implementations.Entities.User;
global using Jellyfin.Database.Implementations.Enums;
#else
global using JfUser = Jellyfin.Data.Entities.User;
#endif
