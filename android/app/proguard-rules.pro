# Debug builds are not minified; these only matter for a future release build.
-keepattributes *Annotation*, InnerClasses
-keep,includedescriptorclasses class com.erkantaylan.listenalong.**$$serializer { *; }
-keepclassmembers class com.erkantaylan.listenalong.** {
    *** Companion;
}
