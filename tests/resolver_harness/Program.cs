// Usage: resolver_harness <mode> <folder> [args]
//   jellyfin <folder> <fileNameWithoutExt|-> <mixed:0|1> <baseName> [allowedCsv]
//   prefixed <folder> <fileNameWithoutExt> <baseName> <multiple:0|1> [allowedCsv]
//   plain    <folder> <baseName> <multiple:0|1> [allowedCsv]
// Prints one resolved path per line, in order.
using Jellyfin.Plugin.ArtworkPlus.Helpers;

var mode = args[0];
List<string> result = mode switch
{
    "jellyfin" => BackdropFileResolver.ResolveLikeJellyfin(args[1], args[2] == "-" ? null : args[2], args[3] == "1", args[4], BackdropFileResolver.ParseAllowedFormats(args.Length > 5 ? args[5] : null)),
    "prefixed" => BackdropFileResolver.ResolvePrefixed(args[1], args[2], args[3], args[4] == "1", BackdropFileResolver.ParseAllowedFormats(args.Length > 5 ? args[5] : null)),
    "plain" => BackdropFileResolver.ResolvePlain(args[1], args[2], args[3] == "1", BackdropFileResolver.ParseAllowedFormats(args.Length > 4 ? args[4] : null)),
    _ => throw new ArgumentException(mode)
};
foreach (var p in result) { Console.WriteLine(Path.GetFileName(p) == p ? p : Path.GetRelativePath(args[1], p)); }
